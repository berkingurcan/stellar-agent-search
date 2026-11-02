/**
 * source.ts — where discovery reads agents from, as an interface.
 *
 * Tools, resources and the CLI read through {@link AgentSource}, never a
 * concrete class. Two implementations exist:
 *
 *   - ExplorerService (explorer.ts): the indexer. It enumerates the registry
 *     and also answers feedback, stats, health and owner lookups.
 *   - RegistryService (registry-source.ts): keyless reads of the Identity
 *     contract, for networks with no indexer: an operator allowlist
 *     (REGISTRY_AGENT_IDS) or the newest registered agents (REGISTRY_SCAN_LIMIT,
 *     testnet's default). It enumerates only that scope, and it has no indexed
 *     reputation.
 *
 * Reads only an indexer can answer live on {@link IndexerReads}, which only the
 * explorer branch of the union carries. A caller reaches them through
 * {@link requireIndexer}, which refuses in registry mode instead of answering
 * from a partial view as if it were complete: degrade closed, never fake.
 */

import type {
  AgentResponse,
  ApiResponse,
  FeedbackResponse,
  HealthResponse,
} from "@trionlabs/stellar8004";
import type {
  DiscoveryCoverage,
  ExplorerStatsResponse,
  FindAgentsOptions,
  FindAgentsResult,
  GetAgentsParams,
  GetFeedbackParams,
} from "./explorer.js";
import { IndexerRequiredError } from "./errors.js";

/** One page of the browse listing (`list_agents`). */
export type ListAgentsParams = Omit<GetAgentsParams, "search" | "page" | "limit"> & {
  page: number;
  limit: number;
};

export interface AgentListPage {
  agents: AgentResponse[];
  pagination: { page: number; limit: number; total: number | null; hasMore: boolean | null };
  coverage: DiscoveryCoverage;
}

/** Reads every source answers. */
export interface AgentReads {
  /** One agent. Throws the SDK's NotFoundError when the source has no such agent. */
  getAgent(id: number): Promise<{ data: AgentResponse }>;
  /** One page of agents in the source's own order, with the source's coverage. */
  listAgents(params: ListAgentsParams): Promise<AgentListPage>;
  /** Candidates for a free-text query and capability filters; does not rank. */
  findAgentsWithCoverage(query: string, opts?: FindAgentsOptions): Promise<FindAgentsResult>;
}

/** Reads that need an indexer. */
export interface IndexerReads {
  getFeedback(id: number, params?: GetFeedbackParams): Promise<ApiResponse<FeedbackResponse[]>>;
  getStats(): Promise<ApiResponse<ExplorerStatsResponse>>;
  health(): Promise<ApiResponse<HealthResponse>>;
  getAgentsByOwner(address: string): Promise<ApiResponse<AgentResponse[]>>;
}

export interface IndexerSource extends AgentReads, IndexerReads {
  readonly kind: "explorer";
}

export interface RegistrySource extends AgentReads {
  readonly kind: "registry";
  /** What a registry-mode result must say about itself. */
  describe(): RegistrySourceNote;
}

export type AgentSource = IndexerSource | RegistrySource;

/** Attached as `source` to registry-mode results; explorer results carry none. */
export interface RegistrySourceNote {
  kind: "registry";
  /**
   * Which agents lists and searches read: the operator's allowlist
   * (REGISTRY_AGENT_IDS), or the newest agents the Identity contract registered
   * (REGISTRY_SCAN_LIMIT; testnet's default).
   */
  scope: "allowlist" | "newest";
  /**
   * The most agents a list or search reads: the allowlist's size, or the scan
   * limit. Lists and searches never see past them.
   */
  allowlistSize: number;
  /** Always false: no indexer, so scores and feedback counts are not measured. */
  reputationIndexed: false;
  note: string;
}

/** The source's indexer reads, or IndexerRequiredError in registry mode. */
export function requireIndexer(source: AgentSource, feature: string): IndexerSource {
  if (source.kind === "registry") throw new IndexerRequiredError(feature);
  return source;
}
