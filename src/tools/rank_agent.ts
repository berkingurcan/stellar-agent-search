/**
 * rank_agent — explicit ranking with the full 3-axis breakdown + on-chain
 * verification. Accepts EITHER an explicit `agentIds` set OR a `query` (XOR).
 * This is where the declared-vs-verified differentiator is most visible.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  NotFoundError,
  ValidationError,
  type AgentResponse,
} from "@trionlabs/stellar8004";
import { parseQuery } from "../lib/nlparse.js";
import { RANKING } from "../lib/ranking.js";
import type {
  DiscoveryCoverage,
  FindAgentsResult,
  GetAgentsParams,
} from "../lib/explorer.js";
import {
  handler,
  mapWithConcurrency,
  MAX_QUERY_LENGTH,
  rankAndVerify,
  summarizeRanked,
  toolResult,
  zLimit,
  zSort,
  READ_ANNOTATIONS,
  type ToolDeps,
} from "./shared.js";
import { zDiscoveryCoverage, zRankedAgent } from "./schemas.js";
import { MAX_AGENT_ID } from "../lib/identifier.js";

const CANDIDATE_PAGE_SIZE = 50;
const VERIFY_CAP = 25;

const inputShape = {
  agentIds: z
    .array(z.number().int().nonnegative().max(MAX_AGENT_ID))
    .min(1)
    .max(50)
    .optional()
    .describe("Explicit agent ids to rank. Provide EITHER agentIds OR query, not both."),
  query: z
    .string()
    .min(1)
    .max(MAX_QUERY_LENGTH)
    .optional()
    .describe("Natural-language query whose candidates are ranked. XOR with agentIds."),
  limit: zLimit(10),
  weights: z
    .object({
      quality: z.number().min(0),
      volume: z.number().min(0),
      breadth: z.number().min(0),
    })
    .partial()
    .optional()
    .describe(
      "Deprecated and rejected when supplied. The v1 policy fixes evidence weights at volume=0.4 and breadth=0.6.",
    ),
  verify: z
    .boolean()
    .default(true)
    .describe(
      "Attempt the bounded Reputation-contract probe (default on; current probe verifies no reputation fields).",
    ),
  sortBy: zSort.default("relevance"),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const outputShape = {
  rankVersion: z.string(),
  evidenceWeights: z.object({ volume: z.number(), breadth: z.number() }),
  count: z.number(),
  agents: z.array(zRankedAgent),
  // Only query-based ranking scans explorer pages. Explicit-id ranking has no
  // meaningful registry-wide coverage claim, so this field is absent there.
  coverage: zDiscoveryCoverage.optional(),
};

async function gatherByIds(deps: ToolDeps, ids: number[]): Promise<AgentResponse[]> {
  const results = await mapWithConcurrency(
    ids,
    deps.policy?.maxExplorerConcurrency ?? 6,
    async (id) => {
      try {
        return (await deps.explorer.getAgent(id)).data;
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    },
  );
  const found = results.filter((a): a is AgentResponse => a != null);
  if (found.length === 0) {
    throw new NotFoundError(`agents [${ids.join(", ")}]`);
  }
  return found;
}

async function gatherByQuery(deps: ToolDeps, query: string): Promise<FindAgentsResult> {
  const parsed = parseQuery(query);
  if (parsed.unsupported.length > 0) {
    throw new ValidationError(
      `Negative capability filters are not supported by Explorer v1: ${parsed.unsupported.join(", ")}.`,
    );
  }
  const filters: Omit<NonNullable<GetAgentsParams>, "search" | "page"> = {
    limit: CANDIDATE_PAGE_SIZE,
  };
  if (parsed.filters.x402 !== undefined) filters.x402 = parsed.filters.x402;
  if (parsed.filters.mpp !== undefined) filters.mpp = parsed.filters.mpp;
  if (parsed.filters.hasServices !== undefined) filters.hasServices = parsed.filters.hasServices;
  if (parsed.filters.trust !== undefined) filters.trust = parsed.filters.trust;
  if (parsed.filters.minExplorerScore !== undefined) {
    filters.minScore = parsed.filters.minExplorerScore;
  }

  return deps.explorer.findAgentsWithCoverage(parsed.keywords.join(" "), {
    filters,
    pages: 2,
    match: "any",
  });
}

export function registerRankAgent(server: McpServer, deps: ToolDeps): void {
  const maxAgentIds = Math.max(1, Math.min(50, deps.policy?.maxRankAgentIds ?? 50));
  const maxLimit = Math.max(1, Math.min(50, deps.policy?.maxRankLimit ?? 50));
  const runtimeInputShape = {
    ...inputShape,
    agentIds: z
      .array(z.number().int().nonnegative().max(MAX_AGENT_ID))
      .min(1)
      .max(maxAgentIds)
      .optional()
      .describe(
        `Explicit agent ids to rank (maximum ${maxAgentIds} on this transport). Provide EITHER agentIds OR query, not both.`,
      ),
    limit: zLimit(Math.min(10, maxLimit), maxLimit),
  };
  server.registerTool(
    "rank_agent",
    {
      title: "Rank Agent",
      description:
        "Rank an explicit agent set or a query's candidates using the deterministic declared-evidence policy: " +
        "normalized indexed average × fixed evidence strength (0.4 capped volume + 0.6 breadth). " +
        "Owner-declared capability fields add zero. On-chain checks are " +
        "evidence metadata and never inflate rank. Every " +
        "row carries a full per-axis `breakdown` and a declared-vs-verified `verification` block. " +
        "Provide EITHER agentIds OR query.",
      inputSchema: z.object(runtimeInputShape),
      outputSchema: z.object(outputShape),
      annotations: { title: "Rank Agent", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      if (args.weights !== undefined) {
        throw new ValidationError(
          "rank_agent.weights is no longer supported: the v1 declared-evidence policy fixes volume=0.4 and breadth=0.6.",
        );
      }
      const hasIds = args.agentIds !== undefined && args.agentIds.length > 0;
      const hasQuery = args.query !== undefined && args.query.length > 0;
      if (hasIds === hasQuery) {
        throw new ValidationError("Provide exactly one of `agentIds` or `query`.");
      }

      let pool: AgentResponse[];
      let coverage: DiscoveryCoverage | undefined;
      if (hasIds) {
        pool = await gatherByIds(deps, args.agentIds!);
      } else {
        const discovery = await gatherByQuery(deps, args.query!);
        pool = discovery.agents;
        coverage = discovery.coverage;
      }

      const rows = await rankAndVerify(deps, pool, {
        sortBy: args.sortBy,
        verify: args.verify,
        verifyTopK: Math.min(args.limit, VERIFY_CAP),
        limit: args.limit,
        includeBreakdown: true,
      });

      return toolResult(summarizeRanked(rows), {
        rankVersion: RANKING.VERSION,
        evidenceWeights: {
          volume: RANKING.EVIDENCE_VOLUME_WEIGHT,
          breadth: RANKING.EVIDENCE_BREADTH_WEIGHT,
        },
        count: rows.length,
        agents: rows,
        ...(coverage ? { coverage } : {}),
      });
    }),
  );
}
