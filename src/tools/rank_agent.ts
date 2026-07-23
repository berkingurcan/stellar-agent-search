/**
 * rank_agent — explicit ranking with the full 3-axis breakdown + on-chain
 * verification. Accepts EITHER an explicit `agentIds` set OR a `query` (XOR).
 * This is where the declared-vs-verified differentiator is most visible.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  NotFoundError,
  ValidationError,
  type AgentResponse,
} from "@trionlabs/stellar8004";
import { parseQuery } from "../lib/nlparse.js";
import { normalizeWeights } from "../lib/ranking.js";
import type { GetAgentsParams } from "../lib/explorer.js";
import {
  deriveCapabilities,
  handler,
  rankAndVerify,
  summarizeRanked,
  toolResult,
  zLimit,
  zSort,
  READ_ANNOTATIONS,
  type ToolDeps,
} from "./shared.js";
import { zRankedAgent } from "./schemas.js";
import type { RankWeights } from "../types.js";

const CANDIDATE_PAGE_SIZE = 50;
const VERIFY_CAP = 25;

const inputShape = {
  agentIds: z
    .array(z.number().int().nonnegative())
    .min(1)
    .max(50)
    .optional()
    .describe("Explicit agent ids to rank. Provide EITHER agentIds OR query, not both."),
  query: z
    .string()
    .min(1)
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
    .describe("Optional axis-weight override; re-normalized to sum 1."),
  verify: z
    .boolean()
    .default(true)
    .describe("On-chain-verify reputation (default on for explicit ranking)."),
  sortBy: zSort.default("relevance"),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const outputShape = {
  weights: z.object({ quality: z.number(), volume: z.number(), breadth: z.number() }),
  count: z.number(),
  agents: z.array(zRankedAgent),
};

async function gatherByIds(deps: ToolDeps, ids: number[]): Promise<AgentResponse[]> {
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return (await deps.explorer.getAgent(id)).data;
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    }),
  );
  const found = results.filter((a): a is AgentResponse => a != null);
  if (found.length === 0) {
    throw new NotFoundError(`agents [${ids.join(", ")}]`);
  }
  return found;
}

async function gatherByQuery(deps: ToolDeps, query: string): Promise<AgentResponse[]> {
  const parsed = parseQuery(query);
  const filters: Omit<NonNullable<GetAgentsParams>, "search" | "page"> = {
    limit: CANDIDATE_PAGE_SIZE,
  };
  if (parsed.filters.x402 !== undefined) filters.x402 = parsed.filters.x402;
  if (parsed.filters.hasServices !== undefined) filters.hasServices = parsed.filters.hasServices;
  if (parsed.filters.trust !== undefined) filters.trust = parsed.filters.trust;
  if (parsed.filters.minScore !== undefined) filters.minScore = parsed.filters.minScore;

  let pool = await deps.explorer.findAgents(parsed.keywords.join(" "), {
    filters,
    pages: 2,
    match: "any",
  });
  if (parsed.filters.mpp) pool = pool.filter((a) => deriveCapabilities(a).mpp);
  return pool;
}

export function registerRankAgent(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "rank_agent",
    {
      title: "Rank Agent",
      description:
        "Rank an explicit agent set or a query's candidates using the deterministic 3-axis engine " +
        "(quality / volume / breadth) with additive capability + on-chain-verified bonuses. Every " +
        "row carries a full per-axis `breakdown` and a declared-vs-verified `verification` block. " +
        "Provide EITHER agentIds OR query.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { title: "Rank Agent", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const hasIds = args.agentIds !== undefined && args.agentIds.length > 0;
      const hasQuery = args.query !== undefined && args.query.length > 0;
      if (hasIds === hasQuery) {
        throw new ValidationError("Provide exactly one of `agentIds` or `query`.");
      }

      const pool = hasIds
        ? await gatherByIds(deps, args.agentIds!)
        : await gatherByQuery(deps, args.query!);

      const weights: RankWeights = {
        quality: args.weights?.quality ?? deps.config.weights.quality,
        volume: args.weights?.volume ?? deps.config.weights.volume,
        breadth: args.weights?.breadth ?? deps.config.weights.breadth,
      };
      const effectiveWeights = normalizeWeights(weights);

      const rows = await rankAndVerify(deps, pool, {
        weights,
        sortBy: args.sortBy,
        verify: args.verify,
        verifyTopK: Math.min(args.limit, VERIFY_CAP),
        limit: args.limit,
        includeBreakdown: true,
      });

      return toolResult(summarizeRanked(rows), {
        weights: effectiveWeights,
        count: rows.length,
        agents: rows,
      });
    }),
  );
}
