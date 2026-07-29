/**
 * list_agents — paginated, filterable agent listing, ranked client-side.
 *
 * A straight browse primitive: fetch one page from the explorer with the given
 * filters, then rank the page with the deterministic engine (declared-only by
 * default; the optional on-chain probe is bounded and verifies no current fields).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ValidationError } from "@trionlabs/stellar8004";
import {
  V1_UNVERSIONED_PAGINATION_LIMITATION,
  type GetAgentsParams,
} from "../lib/explorer.js";
import {
  canonicalTrust,
  handler,
  rankAndVerify,
  summarizeRanked,
  toolResult,
  zLimit,
  zLegacyMinScore,
  zMinExplorerScore,
  zSort,
  zTrust,
  READ_ANNOTATIONS,
  VERIFY_TOP_K,
  type ToolDeps,
} from "./shared.js";
import { zDiscoveryCoverage, zRankedAgent } from "./schemas.js";

const inputShape = {
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
  sortBy: zSort.default("score"),
  limit: zLimit(20),
  page: z.number().int().min(1).default(1),
  verify: z
    .boolean()
    .default(false)
    .describe("Probe the Reputation contract for the top results; current probe verifies no reputation fields."),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const outputShape = {
  count: z.number(),
  page: z.number(),
  pagination: z.object({
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative().nullable(),
    hasMore: z.boolean().nullable(),
  }),
  coverage: zDiscoveryCoverage,
  agents: z.array(zRankedAgent),
};

export function registerListAgents(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_agents",
    {
      title: "List Agents",
      description:
        "Paginated, filterable listing of registered agents, ranked by the 3-axis engine. Filter by " +
        "x402/mpp/hasServices/trust/minExplorerScore. Self-declared text lives in each row's labeled " +
        "`selfDeclared` slot.",
      inputSchema: z.object(inputShape),
      outputSchema: z.object(outputShape),
      annotations: { title: "List Agents", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      if (args.minScore !== undefined) {
        throw new ValidationError(
          "minScore is ambiguous and no longer supported; use minExplorerScore for the upstream v1 Explorer total_score filter.",
        );
      }
      const params: GetAgentsParams = { page: args.page, limit: args.limit };
      if (args.x402 !== undefined) params.x402 = args.x402;
      if (args.mpp !== undefined) params.mpp = args.mpp;
      if (args.hasServices !== undefined) params.hasServices = args.hasServices;
      if (args.trust !== undefined) params.trust = canonicalTrust(args.trust);
      if (args.minExplorerScore !== undefined) params.minScore = args.minExplorerScore;

      const response = await deps.explorer.getAgents(params);
      const agents = response.data ?? [];
      const pagination = response.meta?.pagination;
      const hasMore = typeof pagination?.hasMore === "boolean" ? pagination.hasMore : undefined;

      const rows = await rankAndVerify(deps, agents, {
        sortBy: args.sortBy,
        verify: args.verify,
        verifyTopK: VERIFY_TOP_K,
        limit: args.limit,
        includeBreakdown: false,
      });

      return toolResult(summarizeRanked(rows), {
        count: rows.length,
        page: args.page,
        pagination: {
          page: pagination?.page ?? args.page,
          limit: pagination?.limit ?? args.limit,
          total: Number.isSafeInteger(pagination?.total) ? pagination!.total : null,
          hasMore: hasMore ?? null,
        },
        coverage: {
          coverageComplete: false,
          paginationExhausted: hasMore === false,
          snapshotConsistent: false,
          pagesScanned: 1,
          recordsScanned: agents.length,
          ...(hasMore !== undefined ? { hasMore } : {}),
          limitations: [
            V1_UNVERSIONED_PAGINATION_LIMITATION,
            ...(args.page > 1 ? ["prior-pages-not-scanned"] : []),
            ...(hasMore === undefined ? ["pagination-metadata-unavailable"] : []),
          ],
        },
        agents: rows,
      });
    }),
  );
}
