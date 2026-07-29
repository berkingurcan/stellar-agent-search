/**
 * get_agent_feedback — recent Explorer-indexed on-chain feedback for one agent.
 *
 * Feedback is client-authored (permissionless) → untrusted. Every row is
 * sanitized and the whole list is emitted inside a labeled `selfDeclared` slot;
 * content[].text carries only typed counts. Revoked entries are dropped unless
 * `includeRevoked` is set.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ValidationError } from "@trionlabs/stellar8004";
import { MAX_AGENT_ID, resolveAgentId, STELLAR_ID_RE } from "../lib/identifier.js";
import { safe, selfDeclared, serverText } from "../lib/sanitize.js";
import {
  agentIds,
  collectFeedbackWindow,
  handler,
  MAX_FEEDBACK_TAG_LENGTH,
  toolResult,
  toSafeFeedback,
  READ_ANNOTATIONS,
  type ToolDeps,
} from "./shared.js";
import { zSelfDeclaredSlot } from "./schemas.js";

const inputShape = {
  agent: z
    .union([
      z.number().int().nonnegative().max(MAX_AGENT_ID),
      z.string().max(256).regex(STELLAR_ID_RE, "stellar:{network}:{identity}#{id}"),
      z.string().max(256).regex(/^\d+$/, "numeric agent id"),
    ])
    .describe("Numeric agent id, numeric string, or a full stellar handle."),
  limit: z.number().int().min(1).max(50).default(10),
  page: z.number().int().min(1).default(1),
  tag: z.string().max(MAX_FEEDBACK_TAG_LENGTH).optional().describe("Filter by feedback tag."),
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
  coverage: z
    .object({
      windowComplete: z.boolean(),
      paginationExhausted: z.boolean(),
      snapshotConsistent: z.boolean(),
      pagesScanned: z.number().int().nonnegative(),
      hasMore: z.boolean().optional(),
    })
    .passthrough(),
  feedback: zSelfDeclaredSlot,
};

export function registerGetAgentFeedback(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_agent_feedback",
    {
      title: "Get Agent Feedback",
      description:
        "Recent Explorer-indexed on-chain feedback for one agent (client-authored, untrusted → returned in a labeled " +
        "`selfDeclared` slot, sanitized). Revoked entries are hidden unless includeRevoked is set.",
      inputSchema: z.object(inputShape),
      outputSchema: z.object(outputShape),
      annotations: { title: "Get Agent Feedback", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const id = resolveAgentId(args.agent, {
        network: deps.config.network,
        identity: deps.config.stellar.contracts.identity,
      });
      if (id == null) {
        throw new ValidationError(`Could not resolve agent reference '${String(args.agent)}'.`);
      }

      const window = await collectFeedbackWindow(deps, id, {
        page: args.page,
        limit: args.limit,
        ...(args.tag ? { tag: args.tag } : {}),
        includeRevoked: args.includeRevoked,
      });
      const entries = window.rows.map(toSafeFeedback);

      const ids = agentIds(deps.config, id);
      const text = serverText`Agent ${id}: ${entries.length} feedback row(s) on page ${args.page} (${window.revokedHidden} revoked hidden), on ${safe(
        deps.config.network,
      )}; windowComplete=${window.coverage.windowComplete}.`;

      return toolResult(text, {
        agentId: id,
        stellarId: ids.stellarId,
        page: args.page,
        count: entries.length,
        summary: { returned: entries.length, revokedHidden: window.revokedHidden },
        coverage: window.coverage,
        feedback: selfDeclared(entries),
      });
    }),
  );
}
