/**
 * tools/index.ts — the read-only tool surface.
 *
 * `registerTools(server, deps)` registers every tool on an McpServer. The server
 * bootstrap (owned elsewhere) constructs the deps — or uses `createToolDeps` —
 * and calls this once. All tools are read-only, keyless, and idempotent.
 *
 * Tier-0 (SOW): find_agent, rank_agent, get_agent_profile, list_services
 * Tier-1 (complete-core): list_agents, leaderboard, resolve_agent,
 *   get_agents_by_owner, get_agent_feedback, verify_reputation,
 *   get_registry_stats, get_registry_health
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./shared.js";
import { createToolDeps } from "./shared.js";

import { registerFindAgent } from "./find_agent.js";
import { registerRankAgent } from "./rank_agent.js";
import { registerGetAgentProfile } from "./get_agent_profile.js";
import { registerListServices } from "./list_services.js";
import { registerListAgents } from "./list_agents.js";
import { registerLeaderboard } from "./leaderboard.js";
import { registerResolveAgent } from "./resolve_agent.js";
import { registerGetAgentsByOwner } from "./get_agents_by_owner.js";
import { registerGetAgentFeedback } from "./get_agent_feedback.js";
import { registerVerifyReputation } from "./verify_reputation.js";
import { registerGetRegistryStats, registerGetRegistryHealth } from "./registry.js";

/** Ordered list of every tool registrar (registration order = listing order). */
const REGISTRARS: Array<(server: McpServer, deps: ToolDeps) => void> = [
  // Tier-0 (SOW)
  registerFindAgent,
  registerRankAgent,
  registerGetAgentProfile,
  registerListServices,
  // Tier-1 (complete-core)
  registerListAgents,
  registerLeaderboard,
  registerResolveAgent,
  registerGetAgentsByOwner,
  registerGetAgentFeedback,
  registerVerifyReputation,
  registerGetRegistryStats,
  registerGetRegistryHealth,
];

/** Register all read-only tools on the given server. */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  for (const register of REGISTRARS) register(server, deps);
}

export { createToolDeps };
export type { ToolDeps };
