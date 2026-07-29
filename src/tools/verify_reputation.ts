/**
 * verify_reputation — fail-closed evidence attempt for one agent. The current
 * contract has no public client-count/cursor and its compacted pagination can
 * hide retained addresses after expired index entries, so this release performs
 * a bounded reachability read but never labels a subset/global comparison as
 * verification. Returns "unavailable" with explicit limitations, or "skipped"
 * when contract reads are disabled.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ValidationError } from "@trionlabs/stellar8004";
import { MAX_AGENT_ID, resolveAgentId, STELLAR_ID_RE } from "../lib/identifier.js";
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
      z.number().int().nonnegative().max(MAX_AGENT_ID),
      z.string().max(256).regex(STELLAR_ID_RE, "stellar:{network}:{identity}#{id}"),
      z.string().max(256).regex(/^\d+$/, "numeric agent id"),
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
        "Fail-closed reputation observation for one agent. The current Reputation contract has no " +
        "authoritative client-set count/cursor and expired index entries can create holes, so the " +
        "server performs one bounded reachability read but does not call get_summary or claim a diff. " +
        "Current attempted checks return unavailable with explicit scope; skipped means not attempted.",
      inputSchema: z.object(inputShape),
      outputSchema: z.object(outputShape),
      annotations: { title: "Verify Reputation", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const id = resolveAgentId(args.agent, {
        network: deps.config.network,
        identity: deps.config.stellar.contracts.identity,
      });
      if (id == null) {
        throw new ValidationError(`Could not resolve agent reference '${String(args.agent)}'.`);
      }

      const detail = (await deps.explorer.getAgent(id)).data;
      const declared = declaredReputation(detail);
      const verification = await deps.verifier.verifyAgainst(id, declared, {
        skip: false,
        excludeClient: detail.owner,
      });

      const ids = agentIds(deps.config, id);
      const declaredAvg = verification.declared.average;
      const text = serverText`Agent ${id} reputation ${safe(verification.status)} on ${safe(
        deps.config.network,
      )}: Explorer-declared avg ${declaredAvg == null ? safe("n/a") : declaredAvg}, feedbacks ${
        declared.feedbackCount
      }, unique clients ${declared.uniqueClients}; reason=${safe(
        verification.reason ?? "none",
      )}; verifiedFields=${verification.verifiedFields?.length ?? 0}; snapshotComparable=false.`;

      return toolResult(text, {
        agentId: id,
        stellarId: ids.stellarId,
        verified: verification.status === "verified",
        verification,
      });
    }),
  );
}
