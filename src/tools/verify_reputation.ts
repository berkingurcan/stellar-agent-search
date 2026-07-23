/**
 * verify_reputation — the headline differentiator, isolated: re-derive one
 * agent's reputation directly from the on-chain Reputation contract and diff it
 * against the explorer's DECLARED numbers. Returns the full VerificationResult
 * (declared vs verified vs deltas + status). Degrades to "unavailable" if the
 * RPC is down and "skipped" if on-chain verification is disabled.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ValidationError } from "@trionlabs/stellar8004";
import { resolveAgentId, STELLAR_ID_RE } from "../lib/identifier.js";
import { safe, serverText } from "../lib/sanitize.js";
import {
  agentIds,
  declaredReputation,
  handler,
  toolResult,
  READ_ANNOTATIONS,
  type ToolDeps,
} from "./shared.js";
import { zVerification } from "./schemas.js";

const inputShape = {
  agent: z
    .union([
      z.number().int().nonnegative(),
      z.string().regex(STELLAR_ID_RE, "stellar:{network}:{identity}#{id}"),
      z.string().regex(/^\d+$/, "numeric agent id"),
    ])
    .describe("Numeric agent id, numeric string, or a full stellar handle."),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const outputShape = {
  agentId: z.number(),
  stellarId: z.string(),
  verified: z.boolean(),
  verification: zVerification,
};

export function registerVerifyReputation(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "verify_reputation",
    {
      title: "Verify Reputation",
      description:
        "Trust-minimized reputation check for one agent: re-derives the on-chain average from the " +
        "Reputation contract (get_clients_paginated + get_summary) and diffs it against the " +
        "explorer's declared numbers. Status is verified | mismatch | unavailable | skipped.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { title: "Verify Reputation", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const id = resolveAgentId(args.agent);
      if (id == null) {
        throw new ValidationError(`Could not resolve agent reference '${String(args.agent)}'.`);
      }

      const detail = (await deps.explorer.getAgent(id)).data;
      const declared = declaredReputation(detail);
      const verification = await deps.verifier.verifyAgainst(id, declared, { skip: false });

      const ids = agentIds(deps.config, id);
      const declaredAvg = verification.declared.average;
      const verifiedAvg = verification.verified?.average ?? null;
      const text = serverText`Agent ${id} reputation ${safe(verification.status)} on ${safe(
        deps.config.network,
      )}: declared avg ${declaredAvg == null ? safe("n/a") : declaredAvg} vs on-chain ${
        verifiedAvg == null ? safe("n/a") : verifiedAvg
      } (declared feedbacks ${declared.feedbackCount}, unique clients ${declared.uniqueClients}).`;

      return toolResult(text, {
        agentId: id,
        stellarId: ids.stellarId,
        verified: verification.status === "verified",
        verification,
      });
    }),
  );
}
