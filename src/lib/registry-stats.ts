/**
 * Honest presentation for the explorer v1 `/stats` response.
 *
 * Upstream mixes exact count queries with metrics computed from independently
 * fetched, capped row sets. Keeping this metadata next to every stats payload
 * prevents consumers from silently treating samples as a transactional,
 * registry-wide census.
 */

import type { Config } from "../config.js";
import { UpstreamDataError } from "./errors.js";

export const REGISTRY_STATS_SAMPLE_CAP_AGENTS = 5_000;

export const REGISTRY_STATS_METRIC_DEFINITIONS = {
  totalAgents: "Agent rows reported by an upstream exact-count query.",
  totalFeedbacks: "Feedback rows reported by an upstream exact-count query; this is not an active-only review count.",
  totalValidations: "Validation rows reported by an upstream exact-count query.",
  totalUniqueClients:
    "Sum of each sampled agent's distinct-client count; not a global distinct count of clients, people, or accounts.",
  averageFeedbackScore:
    "Unweighted mean of per-agent average feedback scores in the upstream sample, not a feedback-weighted global average and not guaranteed to use a 0–100 protocol range.",
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

function upstreamError(path: string, expectation: string): never {
  throw new UpstreamDataError(`Explorer field '${path}' must be ${expectation}.`);
}

function requireCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return upstreamError(path, "a non-negative safe integer");
  }
  return value;
}

function requireFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return upstreamError(path, "a finite number");
  }
  return value;
}

function requireDistribution(value: unknown, path: string): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return upstreamError(path, "an object of non-negative safe-integer counts");
  }
  const validated: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    validated[key] = requireCount(count, `${path}.${key}`);
  }
  return validated;
}

function requireNetwork(value: unknown, expected: Config["network"], path: string): void {
  const normalized =
    typeof value === "string" && value.toLowerCase() === "pubnet"
      ? "mainnet"
      : typeof value === "string"
        ? value.toLowerCase()
        : "";
  if (normalized !== expected) upstreamError(path, `network '${expected}'`);
}

/** Attach metric semantics and coverage to the typed upstream values. */
export function buildRegistryStatsView(
  stats: unknown,
  network: Config["network"],
): RegistryStatsView {
  if (typeof stats !== "object" || stats === null || Array.isArray(stats)) {
    upstreamError("stats", "an object");
  }
  const raw = stats as Record<string, unknown>;
  requireNetwork(raw.network, network, "stats.network");
  const totalAgents = requireCount(raw.totalAgents, "stats.totalAgents");
  const totalFeedbacks = requireCount(raw.totalFeedbacks, "stats.totalFeedbacks");
  const totalValidations = requireCount(raw.totalValidations, "stats.totalValidations");
  const totalUniqueClients = requireCount(raw.totalUniqueClients, "stats.totalUniqueClients");
  const averageFeedbackScore = requireFinite(
    raw.averageFeedbackScore,
    "stats.averageFeedbackScore",
  );
  const agentsWithServices = requireCount(raw.agentsWithServices, "stats.agentsWithServices");
  const agentsWithX402 = requireCount(raw.agentsWithX402, "stats.agentsWithX402");
  const agentsWithMpp =
    raw.agentsWithMpp === undefined
      ? null
      : requireCount(raw.agentsWithMpp, "stats.agentsWithMpp");
  const protocolDistribution = requireDistribution(
    raw.protocolDistribution,
    "stats.protocolDistribution",
  );
  const trustDistribution = requireDistribution(
    raw.trustDistribution,
    "stats.trustDistribution",
  );
  return {
    network,
    totalAgents,
    totalFeedbacks,
    totalValidations,
    totalUniqueClients,
    averageFeedbackScore,
    agentsWithServices,
    agentsWithX402,
    agentsWithMpp,
    protocolDistribution,
    trustDistribution,
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

export interface RegistryHealthView {
  [key: string]: unknown;
  status: string;
  network: Config["network"];
  anyStale: boolean;
  indexer: {
    identity: { lastLedger: number; stale: boolean };
    reputation: { lastLedger: number; stale: boolean };
    validation: { lastLedger: number; stale: boolean };
  };
}

/** Runtime-validate the SDK's compile-time-only health response. */
export function buildRegistryHealthView(
  health: unknown,
  network: Config["network"],
): RegistryHealthView {
  if (typeof health !== "object" || health === null || Array.isArray(health)) {
    upstreamError("health", "an object");
  }
  const raw = health as Record<string, unknown>;
  requireNetwork(raw.network, network, "health.network");
  if (raw.status !== "healthy") {
    upstreamError("health.status", "the literal 'healthy'");
  }
  if (typeof raw.indexer !== "object" || raw.indexer === null || Array.isArray(raw.indexer)) {
    upstreamError("health.indexer", "an indexer status object");
  }
  const validateIndexer = (
    value: unknown,
    path: string,
  ): { lastLedger: number; stale: boolean } => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return upstreamError(path, "an object with lastLedger/stale");
    }
    const record = value as Record<string, unknown>;
    const lastLedger = requireCount(record.lastLedger, `${path}.lastLedger`);
    if (typeof record.stale !== "boolean") upstreamError(`${path}.stale`, "a boolean");
    return { lastLedger, stale: record.stale };
  };
  const rawIndexer = raw.indexer as Record<string, unknown>;
  const identity = validateIndexer(rawIndexer.identity, "health.indexer.identity");
  const reputation = validateIndexer(rawIndexer.reputation, "health.indexer.reputation");
  const validation = validateIndexer(rawIndexer.validation, "health.indexer.validation");
  return {
    status: "healthy",
    network,
    anyStale: identity.stale || reputation.stale || validation.stale,
    indexer: { identity, reputation, validation },
  };
}
