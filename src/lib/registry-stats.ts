/**
 * Honest presentation for the explorer v1 `/stats` response.
 *
 * Upstream mixes exact count queries with metrics computed from independently
 * fetched, capped row sets. Keeping this metadata next to every stats payload
 * prevents consumers from silently treating samples as a transactional,
 * registry-wide census.
 */

import type { Config } from "../config.js";
import type { ExplorerStatsResponse } from "./explorer.js";

export const REGISTRY_STATS_SAMPLE_CAP_AGENTS = 5_000;

export const REGISTRY_STATS_METRIC_DEFINITIONS = {
  totalAgents: "Agent rows reported by an upstream exact-count query.",
  totalFeedbacks: "Feedback rows reported by an upstream exact-count query; this is not an active-only review count.",
  totalValidations: "Validation rows reported by an upstream exact-count query.",
  totalUniqueClients:
    "Sum of each sampled agent's distinct-client count; not a global distinct count of clients, people, or accounts.",
  averageFeedbackScore:
    "Unweighted mean of per-agent average feedback scores in the upstream sample, not a feedback-weighted global average.",
  agentsWithServices: "Agent rows with a non-empty services field, from an upstream exact-count query.",
  agentsWithX402: "Agent rows declaring x402 enabled, from an upstream exact-count query.",
  agentsWithMpp:
    "Agent rows declaring MPP enabled, from an upstream exact-count query; null when the explorer/SDK response omits this newer field.",
  protocolDistribution:
    "Counts of service entries by protocol in the upstream agent sample; values are service-entry counts, not distinct-agent counts.",
  trustDistribution:
    "Counts of declared trust tokens in the upstream agent sample; values are token occurrences, not distinct-agent counts.",
} as const;

export const REGISTRY_STATS_LIMITATIONS = [
  "Sampled metrics read at most 5,000 agent rows; upstream v1 does not return the actual sample size or ordering.",
  "Protocol and trust distributions are not proven registry-wide distributions.",
  "totalUniqueClients is a sampled sum of per-agent distinct-client counts, not a globally deduplicated client count.",
  "The upstream queries run independently, so the fields are not guaranteed to describe one transactional snapshot.",
] as const;

export interface RegistryStatsView {
  [key: string]: unknown;
  network: Config["network"];
  totalAgents: number;
  totalFeedbacks: number;
  totalValidations: number;
  totalUniqueClients: number;
  averageFeedbackScore: number;
  agentsWithServices: number;
  agentsWithX402: number;
  agentsWithMpp: number | null;
  protocolDistribution: Record<string, number>;
  trustDistribution: Record<string, number>;
  metricDefinitions: typeof REGISTRY_STATS_METRIC_DEFINITIONS;
  coverage: {
    source: "stellar-8004-explorer-v1";
    exactCountMetrics: string[];
    sampledMetrics: string[];
    sampleCapAgents: typeof REGISTRY_STATS_SAMPLE_CAP_AGENTS;
    sampleSizeKnown: false;
    distributionsGlobalExact: false;
    snapshotConsistent: false;
  };
  limitations: string[];
}

function safeOptionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Attach metric semantics and coverage to the typed upstream values. */
export function buildRegistryStatsView(
  stats: ExplorerStatsResponse,
  network: Config["network"],
): RegistryStatsView {
  const agentsWithMpp = safeOptionalCount(stats.agentsWithMpp);
  return {
    network,
    totalAgents: stats.totalAgents,
    totalFeedbacks: stats.totalFeedbacks,
    totalValidations: stats.totalValidations,
    totalUniqueClients: stats.totalUniqueClients,
    averageFeedbackScore: stats.averageFeedbackScore,
    agentsWithServices: stats.agentsWithServices,
    agentsWithX402: stats.agentsWithX402,
    agentsWithMpp,
    protocolDistribution: stats.protocolDistribution,
    trustDistribution: stats.trustDistribution,
    metricDefinitions: REGISTRY_STATS_METRIC_DEFINITIONS,
    coverage: {
      source: "stellar-8004-explorer-v1",
      exactCountMetrics: [
        "totalAgents",
        "totalFeedbacks",
        "totalValidations",
        "agentsWithServices",
        "agentsWithX402",
        ...(agentsWithMpp === null ? [] : ["agentsWithMpp"]),
      ],
      sampledMetrics: [
        "totalUniqueClients",
        "averageFeedbackScore",
        "protocolDistribution",
        "trustDistribution",
      ],
      sampleCapAgents: REGISTRY_STATS_SAMPLE_CAP_AGENTS,
      sampleSizeKnown: false,
      distributionsGlobalExact: false,
      snapshotConsistent: false,
    },
    limitations: [...REGISTRY_STATS_LIMITATIONS],
  };
}
