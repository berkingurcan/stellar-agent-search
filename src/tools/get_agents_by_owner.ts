/**
 * get_agents_by_owner — the current owner API page (up to 20 agents) for a
 * given owner G-address, ranked client-side. Coverage says whether more rows
 * may exist.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ValidationError } from "@trionlabs/stellar8004";
import { isValidOwnerAddress } from "../lib/identifier.js";
import { V1_UNVERSIONED_PAGINATION_LIMITATION } from "../lib/explorer.js";
import {
  handler,
  rankAndVerify,
  summarizeRanked,
  toolResult,
  zLimit,
  READ_ANNOTATIONS,
  VERIFY_TOP_K,
  type ToolDeps,
} from "./shared.js";
import { zRankedAgent } from "./schemas.js";

const inputShape = {
  owner: z
    .string()
    .max(56)
    .describe("Owner account (Stellar G-address).")
    .refine((s) => isValidOwnerAddress(s), "must be a checksum-valid Stellar G-address"),
  limit: zLimit(20, 20),
  verify: z.boolean().default(false),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const outputShape = {
  owner: z.string(),
  count: z.number(),
  agents: z.array(zRankedAgent),
  coverage: z
    .object({
      coverageComplete: z.boolean(),
      paginationExhausted: z.boolean(),
      snapshotConsistent: z.boolean(),
      pagesScanned: z.number(),
      recordsScanned: z.number(),
      hasMore: z.boolean().optional(),
    })
    .passthrough(),
};

export function registerGetAgentsByOwner(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_agents_by_owner",
    {
      title: "Get Agents By Owner",
      description:
        "List the owner endpoint's current page (up to 20 agents), ranked by the 3-axis engine. " +
        "Coverage explicitly reports whether more owner rows exist. " +
        "Self-declared text lives in each row's labeled `selfDeclared` slot.",
      inputSchema: z.object(inputShape),
      outputSchema: z.object(outputShape),
      annotations: { title: "Get Agents By Owner", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const owner = args.owner.trim();
      if (!isValidOwnerAddress(owner)) {
        throw new ValidationError("`owner` must be a checksum-valid Stellar G-address.");
      }

      const response = await deps.explorer.getAgentsByOwner(owner);
      const agents = response.data ?? [];
      const rows = await rankAndVerify(deps, agents, {
        sortBy: "score",
        verify: args.verify,
        verifyTopK: VERIFY_TOP_K,
        limit: args.limit,
        includeBreakdown: false,
      });

      const hasMore = response.meta?.pagination?.hasMore;
      const paginationExhausted = hasMore === false;
      return toolResult(summarizeRanked(rows), {
        owner,
        count: rows.length,
        agents: rows,
        coverage: {
          coverageComplete: false,
          paginationExhausted,
          snapshotConsistent: false,
          pagesScanned: 1,
          recordsScanned: agents.length,
          ...(typeof hasMore === "boolean" ? { hasMore } : {}),
          limitations: [
            V1_UNVERSIONED_PAGINATION_LIMITATION,
            ...(typeof hasMore === "boolean" ? [] : ["pagination-metadata-unavailable"]),
          ],
        },
      });
    }),
  );
}
