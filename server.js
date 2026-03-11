const express = require("express");
const path = require("path");
const fs = require("fs");
const { Composio } = require("@composio/core");

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3456;
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const CONFIG_FILE = path.join(__dirname, ".user-config.json");
const USER_ID = "pr-dashboard-user";

const composio = new Composio();

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
  catch { return {}; }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let cachedData = { prs: [], lastUpdated: null, errors: [] };

// --- Connection management: find any active connection for a toolkit ---

async function findActiveConnection(toolkit) {
  const accounts = await composio.connectedAccounts.list({
    toolkitSlugs: [toolkit],
    statuses: ["ACTIVE"],
  });
  return accounts.items?.[0] || null;
}

async function getConnectionStatus() {
  const [slack, github] = await Promise.all([
    findActiveConnection("slack").catch(() => null),
    findActiveConnection("github").catch(() => null),
  ]);
  return { slack, github };
}

// --- API: connection status ---

app.get("/api/status", async (req, res) => {
  try {
    const connections = await getConnectionStatus();
    const config = loadConfig();
    res.json({
      slackConnected: !!connections.slack,
      githubConnected: !!connections.github,
      slackUserId: config.slackUserId || "",
      slackChannelId: config.slackChannelId || "",
      configured: !!connections.slack && !!(config.slackUserId) && !!(config.slackChannelId),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: initiate connection via Composio link ---

app.post("/api/connect/:toolkit", async (req, res) => {
  try {
    const toolkit = req.params.toolkit;
    const authConfigs = await composio.authConfigs.list({ toolkitSlugs: [toolkit] });
    const authConfig = authConfigs.items?.[0];
    if (!authConfig) return res.status(400).json({ error: "No " + toolkit + " auth config found in Composio." });

    const callbackUrl = req.body.callbackUrl || (req.protocol + "://" + req.get("host") + "/setup");
    const connectionRequest = await composio.connectedAccounts.link(USER_ID, authConfig.id, { callbackUrl });
    res.json({ redirectUrl: connectionRequest.redirectUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: handle OAuth callback ---

app.post("/api/connect/callback", async (req, res) => {
  try {
    const { connectedAccountId } = req.body;
    if (!connectedAccountId) return res.status(400).json({ error: "Missing connectedAccountId" });
    const account = await composio.connectedAccounts.get(connectedAccountId);
    res.json({ ok: true, toolkit: account.toolkit?.slug || account.toolkit, status: account.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: save Slack config ---

app.post("/api/config", (req, res) => {
  const config = loadConfig();
  if (req.body.slackUserId) config.slackUserId = req.body.slackUserId;
  if (req.body.slackChannelId) config.slackChannelId = req.body.slackChannelId;
  saveConfig(config);
  res.json({ ok: true });
});

// --- Tool execution via SDK ---

let slackUserId = null;
let githubUserId = null;
let slackReady = false;
let githubReady = false;

async function resolveEntityUserId(toolkit) {
  // Try known userIds until tools.execute succeeds for this toolkit
  const candidates = [USER_ID, "testing", "default"];
  const testTool = toolkit === "slack" ? "SLACK_FIND_CHANNELS" : "GITHUB_GET_A_PULL_REQUEST";
  const testArgs = toolkit === "slack" ? { query: "general", limit: 1 } : { owner: "ComposioHQ", repo: "hermes", pull_number: 1 };

  for (const uid of candidates) {
    try {
      await composio.tools.execute(testTool, {
        userId: uid,
        arguments: testArgs,
        dangerouslySkipVersionCheck: true,
      });
      return uid;
    } catch { /* try next */ }
  }
  return null;
}

async function refreshExecutors() {
  const slack = await findActiveConnection("slack").catch(() => null);
  const github = await findActiveConnection("github").catch(() => null);

  if (slack) {
    slackUserId = await resolveEntityUserId("slack");
    slackReady = !!slackUserId;
    if (slackReady) console.log("  Slack connected (entityId: " + slackUserId + ")");
  } else {
    slackReady = false;
  }

  if (github) {
    githubUserId = await resolveEntityUserId("github");
    githubReady = !!githubUserId;
    if (githubReady) console.log("  GitHub connected (entityId: " + githubUserId + ")");
  } else {
    githubReady = false;
  }

  return { slack: slackReady, github: githubReady };
}

async function slackExecute(toolSlug, args) {
  if (!slackReady) throw new Error("Slack not connected. Please connect via /setup.");
  const result = await composio.tools.execute(toolSlug, {
    userId: slackUserId,
    arguments: args,
    dangerouslySkipVersionCheck: true,
  });
  if (result.successful === false) throw new Error(toolSlug + " failed: " + (result.error || "unknown"));
  return result.data;
}

async function githubExecute(toolSlug, args) {
  if (!githubReady) throw new Error("GitHub not connected. Please connect via /setup.");
  const result = await composio.tools.execute(toolSlug, {
    userId: githubUserId,
    arguments: args,
    dangerouslySkipVersionCheck: true,
  });
  if (result.successful === false) throw new Error(toolSlug + " failed: " + (result.error || "unknown"));
  return result.data;
}

// --- PR fetching logic ---

function extractPRLinks(text) {
  const matches = [];
  const regex = /https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push({ url: match[0], repo: match[1], number: parseInt(match[2], 10) });
  }
  return matches;
}

async function fetchSlackChannelPRs(config) {
  const prs = [];
  const oneWeekAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
  const history = await slackExecute("SLACK_FETCH_CONVERSATION_HISTORY", {
    channel: config.slackChannelId,
    limit: 200,
    oldest: String(oneWeekAgo),
  });

  const messages = history?.messages || [];
  const slackUsers = await getSlackUserMap();

  for (const msg of messages) {
    const text = msg.text || "";
    if (!text.includes("<@" + config.slackUserId + ">")) continue;

    const links = extractPRLinks(text);
    for (const link of links) {
      const ts = parseFloat(msg.ts);
      const date = new Date(ts * 1000).toISOString();
      const authorId = msg.user || msg.bot_id || "unknown";
      prs.push({
        title: "PR #" + link.number, url: link.url, repo: link.repo,
        author: slackUsers[authorId] || authorId, date,
        source: "Slack Channel", number: link.number,
      });
    }
  }
  return prs;
}

async function fetchSlackDMPRs(config) {
  const prs = [];
  const conversations = await slackExecute("SLACK_LIST_CONVERSATIONS", {
    types: "im", limit: 200, user: config.slackUserId,
  });

  const dmChannels = (conversations?.channels || []).filter((c) => c.is_im);
  const slackUsers = await getSlackUserMap();

  for (const dm of dmChannels) {
    try {
      const oneWeekAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
      const history = await slackExecute("SLACK_FETCH_CONVERSATION_HISTORY", {
        channel: dm.id, limit: 30, oldest: String(oneWeekAgo),
      });

      for (const msg of (history?.messages || [])) {
        const text = msg.text || "";
        const links = extractPRLinks(text);
        if (links.length === 0) continue;
        if (!/review|look|check|approve|lgtm|pr\b/i.test(text)) continue;

        const authorId = msg.user || "unknown";
        if (authorId === config.slackUserId) continue;

        for (const link of links) {
          const ts = parseFloat(msg.ts);
          const date = new Date(ts * 1000).toISOString();
          prs.push({
            title: "PR #" + link.number, url: link.url, repo: link.repo,
            author: slackUsers[authorId] || authorId, date,
            source: "Slack DM", number: link.number,
          });
        }
      }
    } catch { /* skip unreadable DMs */ }
  }
  return prs;
}

let slackUserCache = null;

async function getSlackUserMap() {
  if (slackUserCache) return slackUserCache;
  try {
    const data = await slackExecute("SLACK_LIST_ALL_USERS", { limit: 500 });
    const members = data?.members || [];
    const map = {};
    for (const m of members) {
      map[m.id] = m.profile?.real_name || m.real_name || m.name || m.id;
    }
    slackUserCache = map;
    return map;
  } catch { return {}; }
}

async function enrichAndFilterPR(pr) {
  if (!githubReady) return pr;
  try {
    const parts = pr.repo.split("/");
    const data = await githubExecute("GITHUB_GET_A_PULL_REQUEST", {
      owner: parts[0], repo: parts[1], pull_number: pr.number,
    });

    if (data?.title) {
      pr.title = data.title;
    } else if (data?.details) {
      const m = data.details.match(/Subject:\s*(?:\[.*?\]\s*)?(.*)/);
      if (m) pr.title = m[1].trim();

      if (data.details.includes('"state": "closed"') || data.details.includes('"merged": true')) {
        pr._exclude = true;
      }
    }

    if (data?.state === "closed" || data?.merged === true) {
      pr._exclude = true;
    }
  } catch (err) {
    console.error("  Enrich failed for " + pr.url + ": " + err.message);
  }
  return pr;
}

function dedup(prs) {
  const seen = new Map();
  for (const pr of prs) {
    if (!seen.has(pr.url)) seen.set(pr.url, pr);
  }
  return Array.from(seen.values());
}

async function pollAll() {
  const config = loadConfig();
  const status = await refreshExecutors();

  if (!slackReady || !config.slackUserId || !config.slackChannelId) {
    console.log("[" + new Date().toISOString() + "] Skipping poll - not configured yet");
    return;
  }

  console.log("[" + new Date().toISOString() + "] Polling for PRs...");
  const errors = [];
  let channelPRs = [];
  let dmPRs = [];

  try {
    channelPRs = await fetchSlackChannelPRs(config);
    console.log("  Slack Channel: " + channelPRs.length + " PRs");
  } catch (err) {
    errors.push("Slack Channel: " + err.message);
    console.error("  Slack Channel error:", err.message);
  }

  try {
    dmPRs = await fetchSlackDMPRs(config);
    console.log("  Slack DMs: " + dmPRs.length + " PRs");
  } catch (err) {
    errors.push("Slack DMs: " + err.message);
    console.error("  Slack DMs error:", err.message);
  }

  let allPRs = dedup([...channelPRs, ...dmPRs]);

  if (githubReady) {
    await Promise.allSettled(allPRs.slice(0, 15).map((pr) => enrichAndFilterPR(pr)));
    allPRs = allPRs.filter((p) => !p._exclude);
  }

  allPRs.sort((a, b) => new Date(b.date) - new Date(a.date));
  cachedData = { prs: allPRs, lastUpdated: new Date().toISOString(), errors };
  console.log("  Total (deduped): " + allPRs.length + " PRs");
}

// --- Routes ---

app.get("/setup", (req, res) => {
  res.sendFile(path.join(__dirname, "setup.html"));
});

app.get("/", async (req, res) => {
  const config = loadConfig();
  const slack = await findActiveConnection("slack").catch(() => null);
  if (!slack || !config.slackUserId || !config.slackChannelId) {
    return res.redirect("/setup");
  }
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/prs", (req, res) => {
  res.json(cachedData);
});

app.post("/api/refresh", async (req, res) => {
  await pollAll();
  res.json(cachedData);
});

app.listen(PORT, async () => {
  console.log("PR Review Dashboard running on port " + PORT);
  await pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);
});
