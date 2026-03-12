require("dotenv").config({ path: __dirname + "/.env.local" });
const express = require("express");
const path = require("path");
const fs = require("fs");
const { Composio } = require("@composio/core");

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3456;
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const DATA_DIR = fs.existsSync("/data") ? "/data" : __dirname;
const CONFIG_FILE = path.join(DATA_DIR, ".user-config.json");
const ARCHIVE_FILE = path.join(DATA_DIR, ".archived-prs.json");
const KNOWN_PRS_FILE = path.join(DATA_DIR, ".known-prs.json");
const USER_ID = "pr-dashboard-user";
const API_KEY = process.env.COMPOSIO_API_KEY;

const composio = new Composio({ apiKey: API_KEY });

function loadConfig() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
  catch { /* no file */ }
  if (process.env.SLACK_USER_ID) config.slackUserId = process.env.SLACK_USER_ID;
  if (process.env.SLACK_CHANNEL_ID) config.slackChannelId = process.env.SLACK_CHANNEL_ID;
  return config;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let cachedData = { prs: [], lastUpdated: null, errors: [] };

function loadArchived() {
  try { return JSON.parse(fs.readFileSync(ARCHIVE_FILE, "utf8")); }
  catch { return []; }
}

function saveArchived(urls) {
  fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(urls, null, 2));
}

function loadKnownPRs() {
  try { return JSON.parse(fs.readFileSync(KNOWN_PRS_FILE, "utf8")); }
  catch { return []; }
}

function saveKnownPRs(prs) {
  fs.writeFileSync(KNOWN_PRS_FILE, JSON.stringify(prs, null, 2));
}

async function resolveConnection(toolkit) {
  const accounts = await composio.connectedAccounts.list({
    toolkitSlugs: [toolkit], statuses: ["ACTIVE"],
  });
  const acc = accounts.items?.[0];
  if (!acc) return null;

  const res = await fetch("https://backend.composio.dev/api/v3/connected_accounts/" + acc.id, {
    headers: { "x-api-key": API_KEY },
  });
  const info = await res.json();
  const token = info.data?.access_token || info.state?.val?.access_token || null;
  return { connId: acc.id, entityId: info.user_id || "testing", token };
}

let slackConn = null;
let githubConn = null;

async function refreshConnections() {
  [slackConn, githubConn] = await Promise.all([
    resolveConnection("slack").catch(() => null),
    resolveConnection("github").catch(() => null),
  ]);
  if (slackConn) console.log("  Slack: " + slackConn.connId + " (entity: " + slackConn.entityId + ")");
  if (githubConn) console.log("  GitHub: " + githubConn.connId + " (entity: " + githubConn.entityId + ")");
}

async function execTool(toolSlug, args, conn) {
  if (!conn) throw new Error("No connection for " + toolSlug);
  const result = await composio.tools.execute(toolSlug, {
    userId: conn.entityId,
    arguments: args,
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(toolSlug + ": " + (result.error || "failed"));
  }
  return result.data?.data || result.data;
}

function slackExec(toolSlug, args) { return execTool(toolSlug, args, slackConn); }
function githubExec(toolSlug, args) { return execTool(toolSlug, args, githubConn); }

app.get("/api/status", async (req, res) => {
  try {
    await refreshConnections();
    const config = loadConfig();
    res.json({
      slackConnected: !!slackConn,
      githubConnected: !!githubConn,
      slackUserId: config.slackUserId || "",
      slackChannelId: config.slackChannelId || "",
      configured: !!slackConn && !!(config.slackUserId) && !!(config.slackChannelId),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/connect/:toolkit", async (req, res) => {
  try {
    const toolkit = req.params.toolkit;
    const authConfigs = await composio.authConfigs.list({ toolkitSlugs: [toolkit] });
    const authConfig = authConfigs.items?.[0];
    if (!authConfig) return res.status(400).json({ error: "No " + toolkit + " auth config found." });
    const callbackUrl = req.body.callbackUrl || (req.protocol + "://" + req.get("host") + "/setup");
    const connectionRequest = await composio.connectedAccounts.link(USER_ID, authConfig.id, { callbackUrl });
    res.json({ redirectUrl: connectionRequest.redirectUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/connect/callback", async (req, res) => {
  try {
    const { connectedAccountId } = req.body;
    if (!connectedAccountId) return res.status(400).json({ error: "Missing connectedAccountId" });
    const account = await composio.connectedAccounts.get(connectedAccountId);
    res.json({ ok: true, toolkit: account.toolkit?.slug || account.toolkit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/config", (req, res) => {
  const config = loadConfig();
  if (req.body.slackUserId) config.slackUserId = req.body.slackUserId;
  if (req.body.slackChannelId) config.slackChannelId = req.body.slackChannelId;
  saveConfig(config);
  res.json({ ok: true });
});

app.post("/api/archive", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing url" });
  const archived = loadArchived();
  if (!archived.includes(url)) archived.push(url);
  saveArchived(archived);
  cachedData.prs = cachedData.prs.filter(p => p.url !== url);
  res.json({ ok: true, archived: archived.length });
});

app.delete("/api/archive", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing url" });
  const archived = loadArchived().filter(u => u !== url);
  saveArchived(archived);
  res.json({ ok: true, archived: archived.length });
});

app.get("/api/archive", (req, res) => {
  res.json(loadArchived());
});

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
  const oneWeekAgo = Math.floor((Date.now() - 2 * 86400000) / 1000);
  const history = await slackExec("SLACK_FETCH_CONVERSATION_HISTORY", {
    channel: config.slackChannelId, limit: 200, oldest: String(oneWeekAgo),
  });
  const slackUsers = await getSlackUserMap();

  for (const msg of (history?.messages || [])) {
    const text = msg.text || "";
    if (!text.includes("<@" + config.slackUserId + ">")) continue;
    for (const link of extractPRLinks(text)) {
      const authorId = msg.user || msg.bot_id || "unknown";
      prs.push({
        title: "PR #" + link.number, url: link.url, repo: link.repo,
        author: slackUsers[authorId] || authorId,
        date: new Date(parseFloat(msg.ts) * 1000).toISOString(),
        source: "Slack Channel", number: link.number,
      });
    }
  }
  return prs;
}

async function fetchSlackDMPRs(config) {
  const prs = [];
  const twoDaysAgo = Math.floor((Date.now() - 2 * 86400000) / 1000);
  const conversations = await slackExec("SLACK_LIST_CONVERSATIONS", {
    types: "im", limit: 200, user: config.slackUserId,
  });
  const slackUsers = await getSlackUserMap();

  const recentDMs = (conversations?.channels || [])
    .filter(c => c.is_im && c.updated && c.updated > twoDaysAgo);

  const BATCH_SIZE = 5;
  for (let i = 0; i < recentDMs.length; i += BATCH_SIZE) {
    const batch = recentDMs.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async (dm) => {
      const history = await slackExec("SLACK_FETCH_CONVERSATION_HISTORY", {
        channel: dm.id, limit: 30, oldest: String(twoDaysAgo),
      });
      return { dm, messages: history?.messages || [] };
    }));

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { dm, messages } = result.value;
      for (const msg of messages) {
        const text = msg.text || "";
        const links = extractPRLinks(text);
        if (links.length === 0) continue;
        if (!/review|look|check|approve|lgtm|pr\b/i.test(text)) continue;
        const authorId = msg.user || "unknown";
        if (authorId === config.slackUserId) continue;

        for (const link of links) {
          prs.push({
            title: "PR #" + link.number, url: link.url, repo: link.repo,
            author: slackUsers[authorId] || authorId,
            date: new Date(parseFloat(msg.ts) * 1000).toISOString(),
            source: "Slack DM", number: link.number,
          });
        }
      }
    }
  }
  return prs;
}

let slackUserCache = null;
async function getSlackUserMap() {
  if (slackUserCache) return slackUserCache;
  try {
    const data = await slackExec("SLACK_LIST_ALL_USERS", { limit: 500 });
    const map = {};
    for (const m of (data?.members || [])) {
      map[m.id] = m.profile?.real_name || m.real_name || m.name || m.id;
    }
    slackUserCache = map;
    return map;
  } catch { return {}; }
}

const GITHUB_USERNAME = process.env.GITHUB_USERNAME || "anshugarg15";

async function enrichAndFilterPR(pr) {
  if (!githubConn) return pr;
  try {
    const [owner, repo] = pr.repo.split("/");
    const data = await githubExec("GITHUB_GET_A_PULL_REQUEST", {
      owner, repo, pull_number: pr.number,
    });
    if (data?.title) {
      pr.title = data.title;
    } else if (data?.details) {
      const m = data.details.match(/Subject:\s*(?:\[.*?\]\s*)?(.*)/);
      if (m) pr.title = m[1].trim();
      if (/\"state\":\s*\"closed\"|\"merged\":\s*true/.test(data.details)) pr._exclude = true;
    }
    if (data?.state === "closed" || data?.merged) pr._exclude = true;

    if (!pr._exclude && githubConn.token) {
      const reviewsRes = await fetch(
        "https://api.github.com/repos/" + owner + "/" + repo + "/pulls/" + pr.number + "/reviews",
        { headers: { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + githubConn.token, "User-Agent": "pr-review-dashboard" } }
      );
      if (reviewsRes.ok) {
        const reviews = await reviewsRes.json();
        const myApproval = reviews.some(
          r => r.user?.login?.toLowerCase() === GITHUB_USERNAME.toLowerCase() && r.state === "APPROVED"
        );
        if (myApproval) pr._exclude = true;
      }
    }
  } catch (err) {
    console.error("  Enrich failed for " + pr.url + ": " + err.message);
  }
  return pr;
}

function dedup(prs) {
  const seen = new Map();
  for (const pr of prs) { if (!seen.has(pr.url)) seen.set(pr.url, pr); }
  return Array.from(seen.values());
}

async function pollAll() {
  const config = loadConfig();
  await refreshConnections();

  if (!slackConn || !config.slackUserId || !config.slackChannelId) {
    console.log("[" + new Date().toISOString() + "] Skipping poll - not configured");
    return;
  }

  console.log("[" + new Date().toISOString() + "] Polling...");
  const errors = [];
  let channelPRs = [], dmPRs = [];

  try { channelPRs = await fetchSlackChannelPRs(config); console.log("  Channel: " + channelPRs.length); }
  catch (err) { errors.push("Channel: " + err.message); }

  try { dmPRs = await fetchSlackDMPRs(config); console.log("  DMs: " + dmPRs.length); }
  catch (err) { errors.push("DMs: " + err.message); }

  const newPRs = dedup([...channelPRs, ...dmPRs]);
  const knownPRs = loadKnownPRs();

  const merged = new Map();
  for (const pr of knownPRs) merged.set(pr.url, pr);
  for (const pr of newPRs) merged.set(pr.url, pr);
  let allPRs = Array.from(merged.values());

  const archived = new Set(loadArchived());
  allPRs = allPRs.filter(p => !archived.has(p.url));

  if (githubConn) {
    await Promise.allSettled(allPRs.slice(0, 30).map(pr => enrichAndFilterPR(pr)));
    allPRs = allPRs.filter(p => !p._exclude);
  }

  saveKnownPRs(allPRs);

  allPRs.sort((a, b) => new Date(b.date) - new Date(a.date));
  cachedData = { prs: allPRs, lastUpdated: new Date().toISOString(), errors };
  console.log("  Total: " + allPRs.length);
}

app.get("/setup", (req, res) => res.sendFile(path.join(__dirname, "setup.html")));

app.get("/", async (req, res) => {
  const config = loadConfig();
  const slack = await resolveConnection("slack").catch(() => null);
  if (!slack || !config.slackUserId || !config.slackChannelId) return res.redirect("/setup");
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/prs", (req, res) => res.json(cachedData));

app.post("/api/refresh", async (req, res) => { await pollAll(); res.json(cachedData); });

app.listen(PORT, async () => {
  console.log("PR Review Dashboard running on port " + PORT);
  await pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);
});
