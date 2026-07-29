/**
 * find_agent — natural-language discovery → ranked list.
 *
 * NL query is parsed deterministically (lib/nlparse), explicit args override the
 * inferred filters, candidates are fetched via getAgents({search}) + client-side
 * filtering (the explorer /search substring-matches poorly and has no score
 * sort), then ranked client-side over the fetched pool.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ValidationError } from "@trionlabs/stellar8004";
import { parseQuery } from "../lib/nlparse.js";
import type { GetAgentsParams } from "../lib/explorer.js";
import {
  canonicalTrust,
  handler,
  MAX_QUERY_LENGTH,
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
import { zDiscoveryCoverage, zInterpretedQuery, zRankedAgent } from "./schemas.js";

const CANDIDATE_PAGE_SIZE = 50;
// 4 pages of headroom for the client-side stem match (the explorer has no
// server-side text filter). The fetch stops early when the indexer signals no
// more pages, so this costs nothing until the registry outgrows ~2 pages.
const CANDIDATE_PAGES = 4;

const inputShape = {
  query: z
    .string()
    .min(1)
    .max(MAX_QUERY_LENGTH)
    .describe("Natural-language description, e.g. 'a paid web scraper with a good reputation'."),
  limit: zLimit(10),
  x402: z.literal(true).optional().describe("When present, require x402 (USDC pay-per-call) support."),
  mpp: z.literal(true).optional().describe("When present, require MPP micropayment support."),
  hasServices: z
    .literal(true)
    .optional()
    .describe("When present, require owner-declared service endpoint candidates."),
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
  coverage: zDiscoveryCoverage,
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
      inputSchema: z.object(inputShape),
      outputSchema: z.object(outputShape),
      annotations: { title: "Find Agent", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const parsed = parseQuery(args.query);
      if (parsed.unsupported.length > 0) {
        throw new ValidationError(
          `Negative capability filters are not supported by Explorer v1: ${parsed.unsupported.join(", ")}.`,
        );
      }

      const effective = {
        x402: args.x402 ?? parsed.filters.x402,
        mpp: args.mpp ?? parsed.filters.mpp,
        hasServices: args.hasServices ?? parsed.filters.hasServices,
        trust: args.trust ? canonicalTrust(args.trust) : parsed.filters.trust,
        minScore: args.minScore ?? parsed.filters.minScore,
      };

      const filters: Omit<NonNullable<GetAgentsParams>, "search" | "page"> = {
        limit: CANDIDATE_PAGE_SIZE,
      };
      if (effective.x402 !== undefined) filters.x402 = effective.x402;
      if (effective.mpp !== undefined) filters.mpp = effective.mpp;
      if (effective.hasServices !== undefined) filters.hasServices = effective.hasServices;
      if (effective.trust !== undefined) filters.trust = effective.trust;
      if (effective.minScore !== undefined) filters.minScore = effective.minScore;

      const searchText = parsed.keywords.join(" ");
      const discovery = await deps.explorer.findAgentsWithCoverage(searchText, {
        filters,
        pages: CANDIDATE_PAGES,
        match: "any",
      });

      const rows = await rankAndVerify(deps, discovery.agents, {
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
          unsupported: parsed.unsupported,
        },
        count: rows.length,
        agents: rows,
        coverage: discovery.coverage,
      });
    }),
  );
}
