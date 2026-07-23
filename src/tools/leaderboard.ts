/**
 * leaderboard — the top-ranked agents overall (optionally within a filter).
 *
 * The explorer has no server-side score sort, so we fetch a broad pool across
 * several pages and rank client-side, returning the top `limit`. On-chain
 * verification is bounded to the top VERIFY_TOP_K when `verify` is set.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetAgentsParams } from "../lib/explorer.js";
import {
  deriveCapabilities,
  handler,
  rankAndVerify,
  summarizeRanked,
  toolResult,
  zLimit,
  zMinScore,
  zTrust,
  READ_ANNOTATIONS,
  VERIFY_TOP_K,
  type ToolDeps,
} from "./shared.js";
import { zRankedAgent } from "./schemas.js";

const POOL_PAGE_SIZE = 50;
const POOL_PAGES = 3;

const inputShape = {
  limit: zLimit(10, 50),
  x402: z.boolean().optional(),
  mpp: z.boolean().optional().describe("Filtered client-side (no server-side MPP filter)."),
  hasServices: z.boolean().optional(),
  trust: zTrust.optional(),
  minScore: zMinScore.optional(),
  verify: z.boolean().default(false).describe("On-chain-verify the top results (slower)."),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const outputShape = {
  count: z.number(),
  agents: z.array(zRankedAgent),
};

export function registerLeaderboard(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "leaderboard",
    {
      title: "Leaderboard",
      description:
        "Top-ranked agents overall (or within an x402/mpp/trust/minScore filter), by the 3-axis " +
        "engine, with per-axis `breakdown`. On-chain verification of the top rows is optional. " +
        "Self-declared text lives in each row's labeled `selfDeclared` slot.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { title: "Leaderboard", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const filters: Omit<NonNullable<GetAgentsParams>, "search" | "page"> = {
        limit: POOL_PAGE_SIZE,
      };
      if (args.x402 !== undefined) filters.x402 = args.x402;
      if (args.hasServices !== undefined) filters.hasServices = args.hasServices;
      if (args.trust !== undefined) filters.trust = args.trust;
      if (args.minScore !== undefined) filters.minScore = args.minScore;

      let pool = await deps.explorer.findAgents("", { filters, pages: POOL_PAGES });
      if (args.mpp) pool = pool.filter((a) => deriveCapabilities(a).mpp);

      const rows = await rankAndVerify(deps, pool, {
        weights: deps.config.weights,
        sortBy: "score",
        verify: args.verify,
        verifyTopK: VERIFY_TOP_K,
        limit: args.limit,
        includeBreakdown: true,
      });

      return toolResult(summarizeRanked(rows), { count: rows.length, agents: rows });
    }),
  );
}
