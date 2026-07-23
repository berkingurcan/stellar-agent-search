/**
 * list_agents — paginated, filterable agent listing, ranked client-side.
 *
 * A straight browse primitive: fetch one page from the explorer with the given
 * filters, then rank the page with the deterministic engine (declared-only by
 * default; on-chain verify optional and bounded).
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
  zSort,
  zTrust,
  READ_ANNOTATIONS,
  VERIFY_TOP_K,
  type ToolDeps,
} from "./shared.js";
import { zRankedAgent } from "./schemas.js";

const inputShape = {
  x402: z.boolean().optional(),
  mpp: z.boolean().optional().describe("Filtered client-side (no server-side MPP filter)."),
  hasServices: z.boolean().optional(),
  trust: zTrust.optional(),
  minScore: zMinScore.optional(),
  sortBy: zSort.default("score"),
  limit: zLimit(20),
  page: z.number().int().min(1).default(1),
  verify: z.boolean().default(false).describe("On-chain-verify the top results (slower)."),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const outputShape = {
  count: z.number(),
  page: z.number(),
  agents: z.array(zRankedAgent),
};

export function registerListAgents(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_agents",
    {
      title: "List Agents",
      description:
        "Paginated, filterable listing of registered agents, ranked by the 3-axis engine. Filter by " +
        "x402/mpp/hasServices/trust/minScore. Self-declared text lives in each row's labeled " +
        "`selfDeclared` slot.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { title: "List Agents", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const params: GetAgentsParams = { page: args.page, limit: args.limit };
      if (args.x402 !== undefined) params.x402 = args.x402;
      if (args.hasServices !== undefined) params.hasServices = args.hasServices;
      if (args.trust !== undefined) params.trust = args.trust;
      if (args.minScore !== undefined) params.minScore = args.minScore;

      let agents = (await deps.explorer.getAgents(params)).data ?? [];
      if (args.mpp) agents = agents.filter((a) => deriveCapabilities(a).mpp);

      const rows = await rankAndVerify(deps, agents, {
        weights: deps.config.weights,
        sortBy: args.sortBy,
        verify: args.verify,
        verifyTopK: VERIFY_TOP_K,
        limit: args.limit,
        includeBreakdown: false,
      });

      return toolResult(summarizeRanked(rows), {
        count: rows.length,
        page: args.page,
        agents: rows,
      });
    }),
  );
}
