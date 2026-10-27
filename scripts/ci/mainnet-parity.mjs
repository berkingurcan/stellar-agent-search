/**
 * mainnet-parity.mjs — run two builds as MCP stdio servers on live mainnet, send each the
 * same tool calls and resource reads, and report every difference in what they return.
 *
 *   node scripts/ci/mainnet-parity.mjs <base-dist> <head-dist>
 *
 * Use it before a release to show a change leaves the explorer path's answers alone. The
 * schemas are not compared here: the MCP surface snapshot and its workflow cover them.
 *
 * The explorer rate-limits, so the builds take turns with a pause between calls and a
 * rate-limited call is retried with backoff. Timestamps are masked, JSON inside text
 * content is parsed before comparing, and a call that differs is run once more on both
 * builds so live data changing between the two calls is not reported as a regression.
 * Exit 1 on any difference, or if a call stays rate-limited (the run is then inconclusive).
 * The report also goes to $GITHUB_STEP_SUMMARY when it is set.
 */

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const [baseDist, headDist] = process.argv.slice(2);
if (!baseDist || !headDist) {
  process.stderr.write("usage: mainnet-parity.mjs <base-dist> <head-dist>\n");
  process.exit(2);
}

const PAUSE_MS = Number(process.env.PARITY_PAUSE_MS ?? 1_500);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function open(dist, label) {
  const env = { ...process.env, STELLAR_NETWORK: "mainnet", LOG_LEVEL: "error" };
  delete env.EXPLORER_BASE_URL;
  delete env.REGISTRY_AGENT_IDS;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(dist, "index.js"), "serve"],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: `parity-${label}`, version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

const VOLATILE_KEY = /^(fetchedAt|generatedAt|asOf|checkedAt|observedAt|timestamp|requestId|latencyMs|durationMs|elapsedMs)$/;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

function normalize(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!VOLATILE_KEY.test(k)) out[k] = normalize(v, k);
    return out;
  }
  if (typeof value === "string") {
    if (key === "text" && /^\s*[[{]/.test(value)) {
      try {
        return normalize(JSON.parse(value));
      } catch {
        // Not JSON after all: compare it as text.
      }
    }
    return value.replace(TIMESTAMP, "<time>");
  }
  return value;
}

function diffPaths(a, b, path = "", out = []) {
  if (isDeepStrictEqual(a, b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}.${k}`, out);
    return out;
  }
  out.push(`${path || "(root)"}: base=${JSON.stringify(a)?.slice(0, 160)} head=${JSON.stringify(b)?.slice(0, 160)}`);
  return out;
}

const rateLimited = (settled) => /rate.?limit/i.test(JSON.stringify(settled));
let stillRateLimited = 0;

async function settle(run, client) {
  for (let attempt = 0; ; attempt++) {
    const settled = await run(client).then(
      (ok) => ({ ok }),
      (error) => ({ error: String(error?.message ?? error) }),
    );
    if (!rateLimited(settled)) return settled;
    if (attempt === 4) {
      stillRateLimited++;
      return settled;
    }
    await pause(10_000 * (attempt + 1));
  }
}

const base = await open(baseDist, "base");
const head = await open(headDist, "head");
let identical = 0;
const differences = [];

async function compare(label, run) {
  let paths = [];
  let headResult;
  for (let attempt = 0; attempt < 2; attempt++) {
    const a = await settle(run, base);
    await pause(PAUSE_MS);
    const b = await settle(run, head);
    await pause(PAUSE_MS);
    headResult = b.ok;
    paths = diffPaths(normalize(a), normalize(b));
    if (paths.length === 0) break;
  }
  process.stdout.write(`${paths.length ? "≠" : "="} ${label}\n`);
  if (paths.length) differences.push({ label, paths });
  else identical++;
  return headResult;
}

const call = (name, args) => (client) => client.callTool({ name, arguments: args });
const CALLS = [
  ["find_agent", { query: "a paid web scraper with a good reputation" }],
  ["find_agent", { query: "best scraper" }],
  ["find_agent", { query: "trusted data agent" }],
  ["find_agent", { query: "oracle", minExplorerScore: 50 }],
  ["find_agent", { query: "agents with score above 70" }],
  ["find_agent", { query: "translation", x402: true, sortBy: "score" }],
  ["find_agent", { query: "scraper without x402" }],
  ["find_agent", { query: "scraper", minScore: 50 }],
  ["list_services", {}],
  ["list_services", { search: "scrape", x402: true }],
  ["list_services", { minExplorerScore: 50, page: 2 }],
  ["list_agents", { limit: 5 }],
  ["list_agents", { limit: 5, page: 2, sortBy: "newest" }],
  ["list_agents", { limit: 5, x402: true, minExplorerScore: 50 }],
  ["rank_agent", { query: "best scraper", verify: false }],
  ["rank_agent", { agentIds: [10, 11, 12, 999999], verify: false }],
  ["rank_agent", { agentIds: [10, 11], verify: true }],
  ["leaderboard", { limit: 5 }],
  ["get_registry_stats", {}],
  ["get_registry_health", {}],
  ["get_agent_profile", { agent: 10 }],
  ["get_agent_profile", { agent: "10", feedbackLimit: 0 }],
  ["get_agent_profile", { agent: 999999 }],
  ["get_agent_card", { agent: 10 }],
  ["verify_reputation", { agent: 10 }],
  ["get_agent_feedback", { agent: 10 }],
  ["resolve_agent", { ref: "10" }],
];

try {
  let owner;
  for (const [name, args] of CALLS) {
    const result = await compare(`${name} ${JSON.stringify(args)}`, call(name, args));
    if (name === "get_agent_profile" && args.agent === 10) owner ??= result?.structuredContent?.profile?.owner;
  }
  if (owner) {
    await compare("get_agents_by_owner {owner of agent 10}", call("get_agents_by_owner", { owner }));
    await compare("resolve_agent {owner of agent 10}", call("resolve_agent", { ref: owner }));
  }
  await compare("resources/list", async (client) => (await client.listResources()).resources);
  for (const uri of [
    "stellar8004://registry",
    "stellar8004://leaderboard",
    "stellar8004://health",
    "stellar8004://agent/10",
    "stellar8004://agent/10/card",
    "stellar8004://agent/10/reputation",
    "stellar8004://agent/10/feedback",
  ]) {
    await compare(`read ${uri}`, (client) => client.readResource({ uri }));
  }
  if (owner) await compare("read stellar8004://owner/{owner of agent 10}", (client) => client.readResource({ uri: `stellar8004://owner/${owner}` }));
} finally {
  await Promise.allSettled([base.close(), head.close()]);
}

const verdict =
  differences.length > 0
    ? `${differences.length} call(s) answer differently.`
    : stillRateLimited > 0
      ? `Inconclusive: ${stillRateLimited} call(s) stayed rate-limited.`
      : "Both builds answered every call the same way.";
process.stdout.write(`\nidentical: ${identical}   different: ${differences.length}   still rate-limited: ${stillRateLimited}\n${verdict}\n`);
for (const d of differences) {
  process.stdout.write(`\n## ${d.label}\n${d.paths.slice(0, 12).map((p) => `  ${p}`).join("\n")}\n`);
  if (d.paths.length > 12) process.stdout.write(`  … ${d.paths.length - 12} more\n`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  let summary = `## Mainnet parity\n\n${verdict}\n\nIdentical: ${identical} · different: ${differences.length} · still rate-limited: ${stillRateLimited}\n`;
  for (const d of differences) {
    summary += `\n### ${d.label}\n\n\`\`\`\n${d.paths.slice(0, 12).join("\n")}\n\`\`\`\n`;
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (differences.length > 0 || stillRateLimited > 0) process.exit(1);
