/**
 * get_agents_by_owner — every agent registered by a given owner G-address,
 * ranked client-side. Useful for provenance / "show me this operator's fleet".
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ValidationError } from "@trionlabs/stellar8004";
import { G_ADDRESS_RE } from "../lib/identifier.js";
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
    .describe("Owner account (Stellar G-address).")
    .refine((s) => G_ADDRESS_RE.test(s.trim()), "must be a Stellar G-address"),
  limit: zLimit(20),
  verify: z.boolean().default(false),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const outputShape = {
  owner: z.string(),
  count: z.number(),
  agents: z.array(zRankedAgent),
};

export function registerGetAgentsByOwner(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_agents_by_owner",
    {
      title: "Get Agents By Owner",
      description:
        "List all agents registered by an owner G-address, ranked by the 3-axis engine. " +
        "Self-declared text lives in each row's labeled `selfDeclared` slot.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { title: "Get Agents By Owner", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const owner = args.owner.trim();
      if (!G_ADDRESS_RE.test(owner)) {
        throw new ValidationError("`owner` must be a Stellar G-address.");
      }

      const agents = (await deps.explorer.getAgentsByOwner(owner)).data ?? [];
      const rows = await rankAndVerify(deps, agents, {
        weights: deps.config.weights,
        sortBy: "score",
        verify: args.verify,
        verifyTopK: VERIFY_TOP_K,
        limit: args.limit,
        includeBreakdown: false,
      });

      return toolResult(summarizeRanked(rows), { owner, count: rows.length, agents: rows });
    }),
  );
}
