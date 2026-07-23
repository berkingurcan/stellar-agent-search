/**
 * registry.ts — registry-wide read tools:
 *   - get_registry_stats  : aggregate counts + distributions (StatsResponse)
 *   - get_registry_health : per-registry indexer liveness/staleness (HealthResponse)
 *
 * Every field surfaced here is server/indexer-typed (numbers, enums, network
 * labels) — no agent-authored free text — so values are safe to interpolate.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safe, sanitizeText, serverText } from "../lib/sanitize.js";
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
  protocolDistribution: z.record(z.number()),
  trustDistribution: z.record(z.number()),
};

export function registerGetRegistryStats(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_registry_stats",
    {
      title: "Get Registry Stats",
      description:
        "Aggregate registry statistics: total agents / feedbacks / validations / unique clients, " +
        "average feedback score, x402 + service coverage, and protocol/trust distributions.",
      inputSchema: {},
      outputSchema: statsOutput,
      annotations: { title: "Get Registry Stats", ...READ_ANNOTATIONS },
    },
    handler<Record<string, never>>(async () => {
      const s = (await deps.explorer.getStats()).data;
      const structured = {
        network: sanitizeText(s.network, 40) || deps.config.network,
        totalAgents: s.totalAgents,
        totalFeedbacks: s.totalFeedbacks,
        totalValidations: s.totalValidations,
        totalUniqueClients: s.totalUniqueClients,
        averageFeedbackScore: s.averageFeedbackScore,
        agentsWithServices: s.agentsWithServices,
        agentsWithX402: s.agentsWithX402,
        protocolDistribution: s.protocolDistribution,
        trustDistribution: s.trustDistribution,
      };
      const text = serverText`Registry on ${safe(deps.config.network)}: ${s.totalAgents} agents, ${
        s.totalFeedbacks
      } feedbacks, ${s.totalUniqueClients} unique clients, avg score ${
        s.averageFeedbackScore
      }/100. x402 agents: ${s.agentsWithX402}, with services: ${s.agentsWithServices}.`;
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
      inputSchema: {},
      outputSchema: healthOutput,
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
