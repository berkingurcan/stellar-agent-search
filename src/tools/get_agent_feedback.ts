/**
 * get_agent_feedback — recent on-chain feedback for one agent.
 *
 * Feedback is client-authored (permissionless) → untrusted. Every row is
 * sanitized and the whole list is emitted inside a labeled `selfDeclared` slot;
 * content[].text carries only typed counts. Revoked entries are dropped unless
 * `includeRevoked` is set.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ValidationError } from "@trionlabs/stellar8004";
import { resolveAgentId, STELLAR_ID_RE } from "../lib/identifier.js";
import { safe, selfDeclared, serverText } from "../lib/sanitize.js";
import {
  agentIds,
  handler,
  toolResult,
  toSafeFeedback,
  READ_ANNOTATIONS,
  type ToolDeps,
} from "./shared.js";
import { zSelfDeclaredSlot } from "./schemas.js";

const inputShape = {
  agent: z
    .union([
      z.number().int().nonnegative(),
      z.string().regex(STELLAR_ID_RE, "stellar:{network}:{identity}#{id}"),
      z.string().regex(/^\d+$/, "numeric agent id"),
    ])
    .describe("Numeric agent id, numeric string, or a full stellar handle."),
  limit: z.number().int().min(1).max(50).default(10),
  page: z.number().int().min(1).default(1),
  tag: z.string().optional().describe("Filter by feedback tag."),
  includeRevoked: z.boolean().default(false),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const outputShape = {
  agentId: z.number(),
  stellarId: z.string(),
  page: z.number(),
  count: z.number(),
  summary: z
    .object({ returned: z.number(), revokedHidden: z.number() })
    .passthrough(),
  feedback: zSelfDeclaredSlot,
};

export function registerGetAgentFeedback(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_agent_feedback",
    {
      title: "Get Agent Feedback",
      description:
        "Recent on-chain feedback for one agent (client-authored, untrusted → returned in a labeled " +
        "`selfDeclared` slot, sanitized). Revoked entries are hidden unless includeRevoked is set.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { title: "Get Agent Feedback", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const id = resolveAgentId(args.agent);
      if (id == null) {
        throw new ValidationError(`Could not resolve agent reference '${String(args.agent)}'.`);
      }

      const params: { page?: number; tag?: string } = { page: args.page };
      if (args.tag) params.tag = args.tag;
      const raw = (await deps.explorer.getFeedback(id, params)).data ?? [];

      const visible = args.includeRevoked ? raw : raw.filter((f) => !f.isRevoked);
      const revokedHidden = args.includeRevoked ? 0 : raw.length - visible.length;
      const entries = visible.slice(0, args.limit).map(toSafeFeedback);

      const ids = agentIds(deps.config, id);
      const text = serverText`Agent ${id}: ${entries.length} feedback row(s) on page ${args.page} (${revokedHidden} revoked hidden), on ${safe(
        deps.config.network,
      )}.`;

      return toolResult(text, {
        agentId: id,
        stellarId: ids.stellarId,
        page: args.page,
        count: entries.length,
        summary: { returned: entries.length, revokedHidden },
        feedback: selfDeclared(entries),
      });
    }),
  );
}
