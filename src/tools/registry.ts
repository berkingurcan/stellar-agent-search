/**
 * registry.ts — registry-wide read tools:
 *   - get_registry_stats  : aggregate counts + distributions (StatsResponse)
 *   - get_registry_health : per-registry indexer liveness/staleness (HealthResponse)
 *
 * Every field surfaced here is server/indexer-typed (numbers, enums, network
 * labels) — no agent-authored free text — so values are safe to interpolate.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { safe, serverText } from "../lib/sanitize.js";
import { buildRegistryHealthView, buildRegistryStatsView } from "../lib/registry-stats.js";
import { handler, toolResult, READ_ANNOTATIONS, type ToolDeps } from "./shared.js";

// ---------------------------------------------------------------------------
// get_registry_stats
// ---------------------------------------------------------------------------

const statsOutput = {
  network: z.string(),
  totalAgents: z.number().int().nonnegative(),
  totalFeedbacks: z.number().int().nonnegative(),
  totalValidations: z.number().int().nonnegative(),
  totalUniqueClients: z.number().int().nonnegative(),
  averageFeedbackScore: z.number(),
  agentsWithServices: z.number().int().nonnegative(),
  agentsWithX402: z.number().int().nonnegative(),
  agentsWithMpp: z.number().int().nonnegative().nullable(),
  protocolDistribution: z.record(z.string(), z.number().int().nonnegative()),
  trustDistribution: z.record(z.string(), z.number().int().nonnegative()),
  metricDefinitions: z.object({
    totalAgents: z.string(),
    totalFeedbacks: z.string(),
    totalValidations: z.string(),
    totalUniqueClients: z.string(),
    averageFeedbackScore: z.string(),
    agentsWithServices: z.string(),
    agentsWithX402: z.string(),
    agentsWithMpp: z.string(),
    protocolDistribution: z.string(),
    trustDistribution: z.string(),
  }),
  coverage: z.object({
    source: z.literal("stellar-8004-explorer-v1"),
    exactCountMetrics: z.array(z.string()),
    sampledMetrics: z.array(z.string()),
    sampleCapAgents: z.literal(5_000),
    sampleSizeKnown: z.literal(false),
    distributionsGlobalExact: z.literal(false),
    snapshotConsistent: z.literal(false),
  }),
  limitations: z.array(z.string()),
};

export function registerGetRegistryStats(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_registry_stats",
    {
      title: "Get Registry Stats",
      description:
        "Explorer v1 registry counts plus sampled metrics, with explicit metric definitions, " +
        "5,000-agent sample cap, non-global distribution warning, and snapshot limitations.",
      inputSchema: z.object({}),
      outputSchema: z.object(statsOutput),
      annotations: { title: "Get Registry Stats", ...READ_ANNOTATIONS },
    },
    handler<Record<string, never>>(async () => {
      const s = (await deps.explorer.getStats()).data;
      const structured = buildRegistryStatsView(s, deps.config.network);
      const mppSummary =
        structured.agentsWithMpp === null ? safe("not returned") : structured.agentsWithMpp;
      const text = serverText`Registry on ${safe(structured.network)}: ${structured.totalAgents} indexed agents, ${
        structured.totalFeedbacks
      } feedback rows. Sampled over at most 5,000 agent rows: sum of per-agent distinct-client counts ${
        structured.totalUniqueClients
      }, unweighted per-agent average score ${structured.averageFeedbackScore} in upstream protocol units. Distributions are not proven global. x402 agents: ${
        structured.agentsWithX402
      }, MPP agents: ${mppSummary}, with services: ${structured.agentsWithServices}.`;
      return toolResult(text, structured);
    }),
  );
}

// ---------------------------------------------------------------------------
// get_registry_health
// ---------------------------------------------------------------------------

const zIndexer = z.object({ lastLedger: z.number().int().nonnegative(), stale: z.boolean() });

const healthOutput = {
  status: z.string(),
  network: z.string(),
  anyStale: z.boolean(),
  indexer: z
    .object({ identity: zIndexer, reputation: zIndexer, validation: zIndexer })
    .passthrough(),
};

export function registerGetRegistryHealth(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_registry_health",
    {
      title: "Get Registry Health",
      description:
        "Per-registry indexer health: last indexed ledger and staleness for the identity, " +
        "reputation, and validation indexers. Staleness weakens the freshness of Explorer-declared data; " +
        "it does not make a bounded contract read exhaustive.",
      inputSchema: z.object({}),
      outputSchema: z.object(healthOutput),
      annotations: { title: "Get Registry Health", ...READ_ANNOTATIONS },
    },
    handler<Record<string, never>>(async () => {
      const h = (await deps.explorer.health()).data;
      const structured = buildRegistryHealthView(h, deps.config.network);
      const text = serverText`Registry indexers on ${safe(structured.network)}: identity ledger ${
        structured.indexer.identity.lastLedger
      } (stale=${structured.indexer.identity.stale}), reputation ledger ${
        structured.indexer.reputation.lastLedger
      } (stale=${structured.indexer.reputation.stale}), validation ledger ${
        structured.indexer.validation.lastLedger
      } (stale=${structured.indexer.validation.stale}).`;
      return toolResult(text, structured);
    }),
  );
}
