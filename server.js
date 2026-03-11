const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3456;

const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || "ak_HDZNFcCWD73uqX1X6928";
const SLACK_CONNECTED_ACCOUNT = process.env.SLACK_CONNECTED_ACCOUNT || "ca_Kh1UxKh-s7LF";
const GITHUB_CONNECTED_ACCOUNT = process.env.GITHUB_CONNECTED_ACCOUNT || "ca_-9_HjKWMsf4X";
const SLACK_ENTITY_ID = "testing";
const GITHUB_ENTITY_ID = "pg-test-6a3987dd-3cb4-4835-9024-997bcb3c0cef";
const SLACK_USER_ID = process.env.SLACK_USER_ID || "U09RYKERAUU";
const SLACK_PR_CHANNEL_ID = process.env.SLACK_PR_CHANNEL_ID || "C08G49WNKCL";
const COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3";

const POLL_INTERVAL_MS = 15 * 60 * 1000;

let cachedData = { prs: [], lastUpdated: null, errors: [] };

async function executeComposioTool(toolSlug, args, connectedAccountId, entityId) {
  const res = await fetch(COMPOSIO_BASE_URL + "/tools/execute/" + toolSlug, {
    method: "POST",
    headers: {
      "x-api-key": COMPOSIO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      connected_account_id: connectedAccountId,
      entity_id: entityId,
      arguments: args,
    }),
  });
  const json = await res.json();
  if (json.error && json.successful === false) {
    throw new Error("Composio tool " + toolSlug + " failed: " + json.error);
  }
  return json.data?.data || json.data;
}

function executeSlackTool(toolSlug, args) {
  return executeComposioTool(toolSlug, args, SLACK_CONNECTED_ACCOUNT, SLACK_ENTITY_ID);
}

function executeGitHubTool(toolSlug, args) {
  return executeComposioTool(toolSlug, args, GITHUB_CONNECTED_ACCOUNT, GITHUB_ENTITY_ID);
}

function extractPRLinks(text) {
  const matches = [];
  const regex = /https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push({
      url: match[0],
      repo: match[1],
      number: parseInt(match[2], 10),
    });
  }
  return matches;
}

async function fetchSlackChannelPRs() {
  const prs = [];
  const oneWeekAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
  const history = await executeSlackTool("SLACK_FETCH_CONVERSATION_HISTORY", {
    channel: SLACK_PR_CHANNEL_ID,
    limit: 200,
    oldest: String(oneWeekAgo),
  });

  const messages = history?.messages || [];
  const slackUsers = await getSlackUserMap();

  for (const msg of messages) {
    const text = msg.text || "";
    if (!text.includes("<@" + SLACK_USER_ID + ">")) continue;

    const links = extractPRLinks(text);
    for (const link of links) {
      const ts = parseFloat(msg.ts);
      const date = new Date(ts * 1000).toISOString();
      const authorId = msg.user || msg.bot_id || "unknown";
      const authorName = slackUsers[authorId] || authorId;

      prs.push({
        title: "PR #" + link.number,
        url: link.url,
        repo: link.repo,
        author: authorName,
        date,
        source: "Slack Channel",
        number: link.number,
      });
    }
  }
  return prs;
}

async function fetchSlackDMPRs() {
  const prs = [];
  const conversations = await executeSlackTool("SLACK_LIST_CONVERSATIONS", {
    types: "im",
    limit: 50,
  });

  const dmChannels = (conversations?.channels || []).filter((c) => c.is_im);
  const slackUsers = await getSlackUserMap();
  const recentDMs = dmChannels.slice(0, 20);

  for (const dm of recentDMs) {
    try {
      const oneWeekAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
      const history = await executeSlackTool("SLACK_FETCH_CONVERSATION_HISTORY", {
        channel: dm.id,
        limit: 30,
        oldest: String(oneWeekAgo),
      });

      const messages = history?.messages || [];
      for (const msg of messages) {
        const text = msg.text || "";
        const links = extractPRLinks(text);
        if (links.length === 0) continue;

        const hasReviewKeyword = /review|look|check|approve|lgtm|pr\b/i.test(text);
        if (!hasReviewKeyword) continue;

        for (const link of links) {
          const ts = parseFloat(msg.ts);
          const date = new Date(ts * 1000).toISOString();
          const authorId = msg.user || "unknown";
          const authorName = slackUsers[authorId] || authorId;

          prs.push({
            title: "PR #" + link.number,
            url: link.url,
            repo: link.repo,
            author: authorName,
            date,
            source: "Slack DM",
            number: link.number,
          });
        }
      }
    } catch (dmErr) {
      // Skip DMs we can't read
    }
  }
  return prs;
}

let slackUserCache = null;

async function getSlackUserMap() {
  if (slackUserCache) return slackUserCache;
  try {
    const data = await executeSlackTool("SLACK_LIST_ALL_USERS", { limit: 500 });
    const members = data?.members || [];
    const map = {};
    for (const m of members) {
      const name = m.profile?.real_name || m.real_name || m.name || m.id;
      map[m.id] = name;
    }
    slackUserCache = map;
    return map;
  } catch {
    return {};
  }
}

async function enrichPRTitle(pr) {
  if (pr.title && !pr.title.startsWith("PR #")) return pr;
  try {
    const parts = pr.repo.split("/");
    const data = await executeGitHubTool("GITHUB_GET_A_PULL_REQUEST", {
      owner: parts[0],
      repo: parts[1],
      pull_number: pr.number,
    });
    if (data?.title) {
      pr.title = data.title;
    }
  } catch (err) {
    console.error("  Enrich failed for " + pr.url + ": " + err.message);
  }
  return pr;
}

function dedup(prs) {
  const seen = new Map();
  for (const pr of prs) {
    if (!seen.has(pr.url)) {
      seen.set(pr.url, pr);
    }
  }
  return Array.from(seen.values());
}

async function pollAll() {
  console.log("[" + new Date().toISOString() + "] Polling for PRs...");
  const errors = [];

  let channelPRs = [];
  let dmPRs = [];

  try {
    channelPRs = await fetchSlackChannelPRs();
    console.log("  Slack Channel: " + channelPRs.length + " PRs");
  } catch (err) {
    errors.push("Slack Channel: " + err.message);
    console.error("  Slack Channel error:", err.message);
  }

  try {
    dmPRs = await fetchSlackDMPRs();
    console.log("  Slack DMs: " + dmPRs.length + " PRs");
  } catch (err) {
    errors.push("Slack DMs: " + err.message);
    console.error("  Slack DMs error:", err.message);
  }

  let allPRs = dedup([...channelPRs, ...dmPRs]);

  const toEnrich = allPRs.filter((p) => p.title.startsWith("PR #")).slice(0, 15);
  await Promise.allSettled(toEnrich.map((pr) => enrichPRTitle(pr)));

  allPRs.sort((a, b) => new Date(b.date) - new Date(a.date));

  cachedData = {
    prs: allPRs,
    lastUpdated: new Date().toISOString(),
    errors,
  };

  console.log("  Total (deduped): " + allPRs.length + " PRs");
}

app.get("/", (req, res) => {
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
