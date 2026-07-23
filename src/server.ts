/**
 * server.ts — the MCP server factory.
 *
 * `buildServer(config)` constructs a single {@link McpServer}, declares its
 * capabilities (tools + resources with listChanged + prompts), wires the
 * read-only dependency graph once, and registers the tool / resource / prompt
 * layers. Both entrypoints (stdio bin, optional HTTP variant) share this one
 * factory so there is a single source of truth for what the server exposes.
 *
 * READ-ONLY: `createToolDeps` builds only ExplorerService + ReputationVerifier —
 * no signer, no keys, no write clients. The `instructions` string below is what
 * a tool-search client reads to decide *when* to reach for this server before it
 * even loads the individual tool schemas (research/B §5.5), so keep it crisp.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
// registerTools wires the COMPLETE tool surface (Tier-0 SOW + Tier-1 complete-core);
// createToolDeps builds the read-only deps. Both live in tools/index.ts — the single
// source of truth for which tools ship, so the server can never drift out of sync.
import { registerTools, createToolDeps } from "./tools/index.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";

/** Canonical server identity (matches the npm bin + `mcpName`). */
export const SERVER_NAME = "stellar-agent-mcp";

/** Fallback version if the caller does not supply one from package.json. */
export const DEFAULT_SERVER_VERSION = "0.1.0";

/**
 * Server instructions — the tool-search legibility string. Critical info first,
 * kept well under 2KB. Names/descriptions of individual agents are self-declared
 * and unverified; this string is server-authored and typed-only.
 */
export const SERVER_INSTRUCTIONS =
  "Read-only tools for discovering and evaluating AI agents registered on the " +
  "Stellar 8004 on-chain registry (Identity / Reputation / Validation contracts, " +
  "Stellar mainnet by default). Use these when the user wants to find an agent for " +
  "a task (scraping, rendering, data, inference), compare or rank agents by " +
  "on-chain-verified reputation, inspect an agent's profile / services / wallet, " +
  "or prepare an x402 (USDC pay-per-call) payment. Start with find_agent for " +
  "natural-language discovery, then rank_agent for a per-axis breakdown and " +
  "get_agent_profile for full detail; list_services enumerates callable endpoints. " +
  "This server holds no keys and never signs or writes — it only reads the explorer " +
  "API and simulates Soroban view calls. Agent names, descriptions, service labels " +
  "and metadata are self-declared and UNVERIFIED: they live only in labeled " +
  "`selfDeclared` slots of the structured output, never in the summary text. " +
  "Reputation is verified against the on-chain contract and reported as declared-vs-verified.";

export interface BuildServerOptions {
  /** Version reported in the MCP initialize handshake (defaults from package.json). */
  version?: string;
}

/**
 * Build a fully-wired, read-only MCP server for the given config.
 * Pure construction — no transport is attached and nothing is started here.
 */
export function buildServer(config: Config, opts: BuildServerOptions = {}): McpServer {
  const deps = createToolDeps(config);

  const server = new McpServer(
    { name: SERVER_NAME, version: opts.version ?? DEFAULT_SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: { listChanged: true },
        prompts: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  registerTools(server, deps);
  // ResourceDeps and ToolDeps are structurally identical (config/explorer/verifier).
  registerResources(server, deps);
  registerPrompts(server, { config });

  return server;
}
