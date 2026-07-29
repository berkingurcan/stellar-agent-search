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
import { safe, sanitizeText, serverText } from "../lib/sanitize.js";
import { buildRegistryStatsView } from "../lib/registry-stats.js";
import { handler, toolResult, READ_ANNOTATIONS, type ToolDeps } from "./shared.js";

// ---------------------------------------------------------------------------
// get_registry_stats
// ---------------------------------------------------------------------------

const statsOutput = {
  network: z.string(),
  totalAgents: z.number(),
  totalFeedbacks: z.number(),
  totalValidations: z.number(),
  totalUniqueClients: z.number(),
  averageFeedbackScore: z.number(),
  agentsWithServices: z.number(),
  agentsWithX402: z.number(),
  agentsWithMpp: z.number().nullable(),
  protocolDistribution: z.record(z.string(), z.number()),
  trustDistribution: z.record(z.string(), z.number()),
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
      const text = serverText`Registry on ${safe(deps.config.network)}: ${s.totalAgents} indexed agents, ${
        s.totalFeedbacks
      } feedback rows. Sampled over at most 5,000 agent rows: sum of per-agent distinct-client counts ${
        s.totalUniqueClients
      }, unweighted per-agent average score ${s.averageFeedbackScore}/100. Distributions are not proven global. x402 agents: ${
        s.agentsWithX402
      }, MPP agents: ${mppSummary}, with services: ${s.agentsWithServices}.`;
      return toolResult(text, structured);
    }),
  );
}

// ---------------------------------------------------------------------------
// get_registry_health
// ---------------------------------------------------------------------------

const zIndexer = z.object({ lastLedger: z.number(), stale: z.boolean() }).passthrough();

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
        "reputation, and validation indexers. A stale reputation indexer explains a temporary " +
        "declared-vs-verified 'unavailable'/'mismatch'.",
      inputSchema: z.object({}),
      outputSchema: z.object(healthOutput),
      annotations: { title: "Get Registry Health", ...READ_ANNOTATIONS },
    },
    handler<Record<string, never>>(async () => {
      const h = (await deps.explorer.health()).data;
      const anyStale = h.indexer.identity.stale || h.indexer.reputation.stale || h.indexer.validation.stale;
      const structured = {
        status: sanitizeText(h.status, 40),
        network: sanitizeText(h.network, 40) || deps.config.network,
        anyStale,
        indexer: {
          identity: { lastLedger: h.indexer.identity.lastLedger, stale: h.indexer.identity.stale },
          reputation: {
            lastLedger: h.indexer.reputation.lastLedger,
            stale: h.indexer.reputation.stale,
          },
          validation: {
            lastLedger: h.indexer.validation.lastLedger,
            stale: h.indexer.validation.stale,
          },
        },
      };
      const text = serverText`Registry indexers on ${safe(deps.config.network)}: identity ledger ${
        h.indexer.identity.lastLedger
      } (stale=${h.indexer.identity.stale}), reputation ledger ${
        h.indexer.reputation.lastLedger
      } (stale=${h.indexer.reputation.stale}), validation ledger ${
        h.indexer.validation.lastLedger
      } (stale=${h.indexer.validation.stale}).`;
      return toolResult(text, structured);
    }),
  );
}
