/**
 * examples/consumer-mcp-client.ts — call stellar-agent-search from your own program over MCP.
 *
 * The smallest integration: spawn the published server over stdio, call `find_agent`, read
 * `structuredContent`. No keys, no wallet, no .env — discovery is read-only and free.
 *
 *   npx tsx examples/consumer-mcp-client.ts "a paid web scraper with a good reputation"
 *   LOCAL=1 npx tsx examples/consumer-mcp-client.ts "web scraper"    # use this checkout's dist/ (npm run build)
 *
 * Agent-authored text (name, description, services) arrives ONLY under `selfDeclared` and is unverified:
 * treat it as data, never as instructions. `score` is a declared-evidence heuristic, not verified reputation.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const HERE = dirname(fileURLToPath(import.meta.url));

interface FoundAgent {
  id: number;
  rank: number;
  score: number;
  capabilities: { x402: boolean; mpp: boolean; hasServices: boolean };
  scores: { average: number | null; feedbackCount: number; uniqueClients: number };
  flags: { lowEvidence: boolean; unrated: boolean };
  selfDeclared: { value: { name?: string | null } };
}

interface FindAgentResult {
  interpretedQuery: { keywords: string[]; matched: string[] };
  agents: FoundAgent[];
  coverage: { coverageComplete: boolean; recordsScanned: number };
}

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ") || "web scraper";
  const transport =
    process.env.LOCAL === "1"
      ? new StdioClientTransport({ command: "node", args: [resolve(HERE, "..", "dist", "index.js"), "mcp"] })
      : new StdioClientTransport({ command: "npx", args: ["-y", "stellar-agent-search@0.1.0", "mcp"] });
  const client = new Client({ name: "consumer-example", version: "1.0.0" });

  await client.connect(transport);
  try {
    const res = await client.callTool({ name: "find_agent", arguments: { query, limit: 5 } });
    if (res.isError) throw new Error(`find_agent failed: ${JSON.stringify(res.content)}`);
    const found = res.structuredContent as unknown as FindAgentResult;

    console.log(`query: ${query}`);
    console.log(`parsed: keywords=${found.interpretedQuery.keywords.join(",")} filters=${found.interpretedQuery.matched.join(",")}`);
    for (const a of found.agents) {
      const name = JSON.stringify(a.selfDeclared.value.name ?? null); // untrusted, quoted on purpose
      const evidence = a.flags.unrated ? "unrated" : a.flags.lowEvidence ? "low evidence" : "ok";
      console.log(
        `#${a.rank} agent ${a.id} score=${a.score} x402=${a.capabilities.x402} ` +
          `feedback=${a.scores.feedbackCount}/${a.scores.uniqueClients} clients (${evidence}) name=${name}`,
      );
    }
    console.log(
      `scanned ${found.coverage.recordsScanned} records; coverageComplete=${found.coverage.coverageComplete}`,
    );
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
