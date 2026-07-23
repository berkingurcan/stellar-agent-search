/**
 * find_agent — natural-language discovery → ranked list.
 *
 * NL query is parsed deterministically (lib/nlparse), explicit args override the
 * inferred filters, candidates are fetched via getAgents({search}) + client-side
 * filtering (the explorer /search substring-matches poorly and has no score
 * sort), then ranked client-side over the fetched pool.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseQuery } from "../lib/nlparse.js";
import type { GetAgentsParams } from "../lib/explorer.js";
import {
  handler,
  rankAndVerify,
  summarizeRanked,
  toolResult,
  zLimit,
  zMinScore,
  zSort,
  zTrust,
  READ_ANNOTATIONS,
  VERIFY_TOP_K,
  type ToolDeps,
} from "./shared.js";
import { deriveCapabilities } from "./shared.js";
import { zInterpretedQuery, zRankedAgent } from "./schemas.js";

const CANDIDATE_PAGE_SIZE = 50;
const CANDIDATE_PAGES = 2;

const inputShape = {
  query: z
    .string()
    .min(1)
    .describe("Natural-language description, e.g. 'a paid web scraper with a good reputation'."),
  limit: zLimit(10),
  x402: z.boolean().optional().describe("Require x402 (USDC pay-per-call) support."),
  mpp: z.boolean().optional().describe("Require MPP micropayment support (filtered client-side)."),
  hasServices: z.boolean().optional().describe("Require invokable service endpoints."),
  trust: zTrust.optional().describe("Require a trust model."),
  minScore: zMinScore.optional().describe("Minimum declared reputation score (0..100)."),
  sortBy: zSort.default("relevance"),
  verify: z
    .boolean()
    .default(false)
    .describe("On-chain-verify the top results (slower; default off for discovery)."),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const outputShape = {
  interpretedQuery: zInterpretedQuery,
  count: z.number(),
  agents: z.array(zRankedAgent),
};

export function registerFindAgent(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "find_agent",
    {
      title: "Find Agent",
      description:
        "Natural-language discovery of on-chain Stellar (stellar-8004) agents. Returns a ranked " +
        "list with capability/reputation signals. Use rank_agent for per-axis breakdowns and " +
        "get_agent_profile for full detail. Agent names/descriptions are self-declared (unverified) " +
        "and live only in each row's labeled `selfDeclared` slot.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { title: "Find Agent", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const parsed = parseQuery(args.query);

      const effective = {
        x402: args.x402 ?? parsed.filters.x402,
        mpp: args.mpp ?? parsed.filters.mpp,
        hasServices: args.hasServices ?? parsed.filters.hasServices,
        trust: args.trust ?? parsed.filters.trust,
        minScore: args.minScore ?? parsed.filters.minScore,
      };

      const filters: Omit<NonNullable<GetAgentsParams>, "search" | "page"> = {
        limit: CANDIDATE_PAGE_SIZE,
      };
      if (effective.x402 !== undefined) filters.x402 = effective.x402;
      if (effective.hasServices !== undefined) filters.hasServices = effective.hasServices;
      if (effective.trust !== undefined) filters.trust = effective.trust;
      if (effective.minScore !== undefined) filters.minScore = effective.minScore;

      const searchText = parsed.keywords.join(" ");
      let pool = await deps.explorer.findAgents(searchText, {
        filters,
        pages: CANDIDATE_PAGES,
        match: "any",
      });

      // MPP has no server-side filter → apply client-side.
      if (effective.mpp) pool = pool.filter((a) => deriveCapabilities(a).mpp);

      const rows = await rankAndVerify(deps, pool, {
        weights: deps.config.weights,
        sortBy: args.sortBy,
        verify: args.verify,
        verifyTopK: VERIFY_TOP_K,
        limit: args.limit,
        includeBreakdown: false,
      });

      const filterRecord: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(effective)) if (v !== undefined) filterRecord[k] = v;

      return toolResult(summarizeRanked(rows), {
        interpretedQuery: {
          keywords: parsed.keywords,
          filters: filterRecord,
          matched: parsed.matched,
        },
        count: rows.length,
        agents: rows,
      });
    }),
  );
}
