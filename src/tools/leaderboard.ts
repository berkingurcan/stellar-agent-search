/**
 * leaderboard — the top-ranked agents overall (optionally within a filter).
 *
 * The explorer has no server-side score sort, so we fetch a broad pool across
 * several pages and rank client-side, returning the top `limit`. On-chain
 * verification is bounded to the top VERIFY_TOP_K when `verify` is set.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ValidationError } from "@trionlabs/stellar8004";
import type { GetAgentsParams } from "../lib/explorer.js";
import {
  canonicalTrust,
  handler,
  rankAndVerify,
  summarizeRanked,
  toolResult,
  zLimit,
  zLegacyMinScore,
  zMinExplorerScore,
  zTrust,
  READ_ANNOTATIONS,
  VERIFY_TOP_K,
  type ToolDeps,
} from "./shared.js";
import { zDiscoveryCoverage, zRankedAgent } from "./schemas.js";

const POOL_PAGE_SIZE = 50;
const POOL_PAGES = 3;

const inputShape = {
  limit: zLimit(10, 50),
  x402: z.literal(true).optional(),
  mpp: z.literal(true).optional().describe("When present, require indexed MPP support."),
  hasServices: z.literal(true).optional(),
  trust: zTrust.optional(),
  minExplorerScore: zMinExplorerScore.optional().describe(
    "Minimum upstream v1 Explorer total_score in protocol units; not local rank.",
  ),
  minScore: zLegacyMinScore
    .optional()
    .describe("Deprecated ambiguous input; rejected. Use minExplorerScore."),
  verify: z
    .boolean()
    .default(false)
    .describe("Probe the Reputation contract for the top results; current probe verifies no reputation fields."),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const outputShape = {
  count: z.number(),
  agents: z.array(zRankedAgent),
  coverage: zDiscoveryCoverage,
};

export function registerLeaderboard(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "leaderboard",
    {
      title: "Leaderboard",
      description:
        "Top-ranked agents in a bounded registry scan (or filter), by the 3-axis " +
        "engine, with per-axis `breakdown`. On-chain verification of the top rows is optional. " +
        "Coverage states whether the scan exhausted the filtered set; self-declared text lives in " +
        "each row's labeled `selfDeclared` slot.",
      inputSchema: z.object(inputShape),
      outputSchema: z.object(outputShape),
      annotations: { title: "Leaderboard", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      if (args.minScore !== undefined) {
        throw new ValidationError(
          "minScore is ambiguous and no longer supported; use minExplorerScore for the upstream v1 Explorer total_score filter.",
        );
      }
      const filters: Omit<NonNullable<GetAgentsParams>, "search" | "page"> = {
        limit: POOL_PAGE_SIZE,
      };
      if (args.x402 !== undefined) filters.x402 = args.x402;
      if (args.mpp !== undefined) filters.mpp = args.mpp;
      if (args.hasServices !== undefined) filters.hasServices = args.hasServices;
      if (args.trust !== undefined) filters.trust = canonicalTrust(args.trust);
      if (args.minExplorerScore !== undefined) filters.minScore = args.minExplorerScore;

      const discovery = await deps.explorer.findAgentsWithCoverage("", {
        filters,
        pages: POOL_PAGES,
      });

      const rows = await rankAndVerify(deps, discovery.agents, {
        sortBy: "score",
        verify: args.verify,
        verifyTopK: VERIFY_TOP_K,
        limit: args.limit,
        includeBreakdown: true,
      });

      return toolResult(summarizeRanked(rows), {
        count: rows.length,
        agents: rows,
        coverage: discovery.coverage,
      });
    }),
  );
}
