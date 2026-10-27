/**
 * testnet-smoke.mjs — registry mode against the live testnet, through the built binary
 * (dist/index.js): the public Soroban RPC, the Identity contract and the providers'
 * registration files. It checks what the pilot relies on, not what unit tests already pin.
 *
 *   npm run build
 *   REGISTRY_AGENT_IDS=1,2,3 SMOKE_QUERY=seller node scripts/ci/testnet-smoke.mjs
 *
 * SMOKE_QUERY must match at least one allowlisted agent. STELLAR_RPC_URL overrides the
 * default testnet RPC. Exit 1 if any check fails; the report also goes to
 * $GITHUB_STEP_SUMMARY when it is set. Not a merge gate: a testnet reset or a provider's
 * hosting can fail it for reasons unrelated to a change.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = resolve(ROOT, "dist", "index.js");
const ids = process.env.REGISTRY_AGENT_IDS?.trim();
const query = process.env.SMOKE_QUERY?.trim();

if (!ids || !query) {
  process.stderr.write("testnet-smoke: set REGISTRY_AGENT_IDS and SMOKE_QUERY\n");
  process.exit(2);
}
if (!existsSync(BIN)) {
  process.stderr.write("testnet-smoke: dist/index.js is missing; run `npm run build` first\n");
  process.exit(2);
}

const env = { ...process.env, STELLAR_NETWORK: "testnet", REGISTRY_AGENT_IDS: ids };
delete env.EXPLORER_BASE_URL;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "✓" : "✗"} ${name} — ${detail}\n`);
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const errorOf = (result) => {
  try {
    return JSON.parse(result.content?.[0]?.text ?? "");
  } catch {
    return { error: result.content?.[0]?.text ?? "", code: "UNKNOWN" };
  }
};

/** One retry for a transport or upstream hiccup, so a single slow RPC answer is not a failed night. */
async function callTool(client, name, args) {
  for (let attempt = 0; ; attempt++) {
    const result = await client.callTool({ name, arguments: args }).catch((error) => ({
      isError: true,
      content: [{ text: JSON.stringify({ error: String(error?.message ?? error), code: "TRANSPORT" }) }],
    }));
    const transient = result.isError && ["UPSTREAM_ERROR", "TIMEOUT", "TRANSPORT"].includes(errorOf(result).code);
    if (!transient || attempt === 1) return result;
    await pause(5_000);
  }
}

const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "serve"], env, stderr: "pipe" });
let serverLog = "";
transport.stderr?.on("data", (chunk) => {
  serverLog += chunk;
});
const client = new Client({ name: "testnet-smoke", version: "0" }, { capabilities: {} });

try {
  await client.connect(transport);
  check("instructions", /REGISTRY MODE/.test(client.getInstructions() ?? ""), "the server says it is in registry mode");

  const found = await callTool(client, "find_agent", { query });
  const agents = found.structuredContent?.agents ?? [];
  const coverage = found.structuredContent?.coverage ?? {};
  const foundIds = agents.map((agent) => agent.id);
  check(
    `find_agent "${query}"`,
    !found.isError && agents.length > 0 && found.structuredContent?.source?.kind === "registry" &&
      coverage.limitations?.includes("registry-allowlist-only") &&
      !coverage.limitations?.includes("implied-score-filter-not-applied"),
    found.isError
      ? `error ${errorOf(found).code}: ${errorOf(found).error}`
      : `agents ${JSON.stringify(foundIds)}; unreadable ${JSON.stringify(coverage.unreadableAgentIds ?? [])}`,
  );

  const best = await callTool(client, "find_agent", { query: `best ${query}` });
  const bestIds = (best.structuredContent?.agents ?? []).map((agent) => agent.id);
  check(
    `find_agent "best ${query}"`,
    !best.isError &&
      best.structuredContent?.coverage?.limitations?.includes("implied-score-filter-not-applied") &&
      JSON.stringify([...bestIds].sort()) === JSON.stringify([...foundIds].sort()),
    best.isError
      ? `error ${errorOf(best).code}: ${errorOf(best).error}`
      : `agents ${JSON.stringify(bestIds)}, implied score dropped and said so`,
  );

  const scored = await callTool(client, "find_agent", { query, minExplorerScore: 50 });
  check(
    "explicit minExplorerScore",
    scored.isError === true && errorOf(scored).code === "INDEXER_REQUIRED",
    scored.isError ? `refused with ${errorOf(scored).code}` : "was answered instead of refused",
  );

  const leaderboard = await callTool(client, "leaderboard", {});
  check(
    "leaderboard",
    leaderboard.isError === true && errorOf(leaderboard).code === "INDEXER_REQUIRED",
    leaderboard.isError ? `refused with ${errorOf(leaderboard).code}` : "was answered instead of refused",
  );

  if (foundIds.length) {
    const profile = await callTool(client, "get_agent_profile", { agent: foundIds[0] });
    const stellarId = profile.structuredContent?.profile?.stellarId ?? "";
    check(
      `get_agent_profile ${foundIds[0]}`,
      !profile.isError && stellarId.startsWith("stellar:testnet:"),
      profile.isError ? `error ${errorOf(profile).code}: ${errorOf(profile).error}` : stellarId,
    );
  }

  const services = await callTool(client, "list_services", {});
  check(
    "list_services",
    !services.isError && services.structuredContent?.source?.kind === "registry",
    services.isError
      ? `error ${errorOf(services).code}: ${errorOf(services).error}`
      : `${services.structuredContent?.services?.length ?? 0} service listing(s)`,
  );
} catch (error) {
  check("session", false, String(error?.message ?? error));
} finally {
  await client.close().catch(() => {});
}

// The CLI path the pilot's operators use.
const cli = (args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8", timeout: 120_000 });
const bestCli = cli(["find", `best ${query}`]);
check(
  `cli find "best ${query}"`,
  bestCli.status === 0 && /implies a minimum score/.test(bestCli.stdout),
  bestCli.status !== 0
    ? `exit ${bestCli.status}: ${bestCli.stderr.trim().split("\n").pop()}`
    : /implies a minimum score/.test(bestCli.stdout)
      ? "exit 0, implied score dropped and said so"
      : "exit 0, but no note that the implied score was dropped",
);
const scoredCli = cli(["find", query, "--min-explorer-score", "50"]);
check("cli find --min-explorer-score", scoredCli.status !== 0, `exit ${scoredCli.status} (refused)`);
const doctor = cli(["doctor", "--json"]);
let doctorReport;
try {
  doctorReport = JSON.parse(doctor.stdout);
} catch {
  doctorReport = undefined;
}
check(
  "cli doctor",
  doctor.status === 0 && doctorReport?.ok === true,
  doctorReport
    ? doctorReport.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ") || "all checks passed"
    : `exit ${doctor.status}: ${doctor.stderr.trim().split("\n").pop()}`,
);

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed (agents ${ids}, query "${query}")\n`);
if (failed.length && serverLog.trim()) process.stdout.write(`\nserver stderr:\n${serverLog.trim().split("\n").slice(-20).join("\n")}\n`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.name} | ${String(r.detail).replaceAll("|", "\\|")} |`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Testnet smoke\n\nAgents \`${ids}\`, query \`${query}\`\n\n| | Check | Detail |\n|---|---|---|\n${rows.join("\n")}\n`,
  );
}

if (failed.length) {
  for (const result of failed) process.stdout.write(`::error title=Testnet smoke: ${result.name}::${result.detail}\n`);
  process.exit(1);
}
