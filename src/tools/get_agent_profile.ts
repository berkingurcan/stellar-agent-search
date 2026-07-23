/**
 * get_agent_profile — deep profile for one agent: typed identity + capabilities
 * + scores + 3-axis breakdown + declared-vs-verified reputation + recent
 * feedback + the canonical stellar identifier + an A2A AgentCard projection.
 *
 * Trust boundary: all agent-authored free text (name/description/services/
 * metadata/image) is confined to `profile.selfDeclared`; the AgentCard and
 * feedback (both carry untrusted text) are emitted inside labeled `selfDeclared`
 * slots. content[].text interpolates only typed/enum/numeric values.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ValidationError } from "@trionlabs/stellar8004";
import { resolveAgentId, STELLAR_ID_RE } from "../lib/identifier.js";
import { scoreAgent } from "../lib/ranking.js";
import { toAgentCard } from "../lib/agentcard.js";
import {
  buildSelfDeclaredFields,
  safe,
  sanitizeNullable,
  sanitizeText,
  selfDeclared,
  serverText,
  CAPS,
} from "../lib/sanitize.js";
import {
  agentIds,
  agentScores,
  declaredReputation,
  deriveCapabilities,
  handler,
  toolResult,
  toSafeFeedback,
  toRankInput,
  READ_ANNOTATIONS,
  type ToolDeps,
} from "./shared.js";
import { zAgentProfile, zSelfDeclaredSlot, zVerification } from "./schemas.js";
import type { AgentProfile } from "../types.js";

const inputShape = {
  agent: z
    .union([
      z.number().int().nonnegative(),
      z.string().regex(STELLAR_ID_RE, "stellar:{network}:{identity}#{id}"),
      z.string().regex(/^\d+$/, "numeric agent id"),
    ])
    .describe("Numeric agent id, numeric string, or a full stellar:{network}:{identity}#{id} handle."),
  feedbackLimit: z.number().int().min(0).max(50).default(5),
  verify: z.boolean().default(true).describe("On-chain-verify reputation (default on)."),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const outputShape = {
  profile: zAgentProfile,
  agentCard: zSelfDeclaredSlot,
  recentFeedback: zSelfDeclaredSlot,
  verification: zVerification,
};

export function registerGetAgentProfile(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_agent_profile",
    {
      title: "Get Agent Profile",
      description:
        "Full profile for one agent: typed identity, capabilities, declared scores, a 3-axis rank " +
        "breakdown, declared-vs-on-chain-verified reputation, recent feedback, the canonical " +
        "stellar:{network}:{identity}#{id} handle, and an A2A AgentCard projection. Self-declared " +
        "text is confined to labeled `selfDeclared` slots.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { title: "Get Agent Profile", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const id = resolveAgentId(args.agent);
      if (id == null) {
        throw new ValidationError(`Could not resolve agent reference '${String(args.agent)}'.`);
      }

      const detail = (await deps.explorer.getAgent(id)).data;
      const declared = declaredReputation(detail);
      const verification = await deps.verifier.verifyAgainst(id, declared, { skip: !args.verify });

      const result = scoreAgent(toRankInput(detail, verification.status), {
        weights: deps.config.weights,
        scoreMax: deps.config.scoreMax,
      });

      const ids = agentIds(deps.config, id);
      const caps = deriveCapabilities(detail);

      const profile: AgentProfile = {
        id,
        stellarId: ids.stellarId,
        caip2Id: ids.caip2Id,
        network: deps.config.network,
        owner: sanitizeText(detail.owner, 60),
        wallet: detail.wallet ?? null,
        agentUri: sanitizeNullable(detail.agentUri, CAPS.serviceEndpoint),
        capabilities: caps,
        supportedTrust: caps.supportedTrust,
        scores: agentScores(detail),
        verification,
        verified: verification.status === "verified",
        flags: result.flags,
        rank: result,
        createdAt: detail.createdAt ?? null,
        txHash: detail.txHash ?? null,
        resolveStatus: detail.resolveStatus ?? null,
        selfDeclared: buildSelfDeclaredFields({
          name: detail.name ?? null,
          description: detail.description ?? null,
          image: detail.image ?? null,
          services: detail.services ?? null,
          metadata: detail.metadata ?? null,
        }),
      };

      // Recent feedback: drop revoked, cap to feedbackLimit, sanitize + label.
      let recent: ReturnType<typeof toSafeFeedback>[] = [];
      if (args.feedbackLimit > 0) {
        const fb = (await deps.explorer.getFeedback(id, { page: 1 })).data ?? [];
        recent = fb
          .filter((f) => !f.isRevoked)
          .slice(0, args.feedbackLimit)
          .map(toSafeFeedback);
      }

      const card = toAgentCard(profile);

      const avg = declared.average;
      const text = serverText`Agent ${id} on ${safe(deps.config.network)}: reputation ${safe(
        verification.status,
      )}, declared avg ${avg == null ? safe("n/a") : avg} over ${declared.feedbackCount} feedback(s), ${
        declared.uniqueClients
      } unique client(s). Score ${result.score100}/100, confidence ${Math.round(
        result.confidence * 100,
      )}%. x402=${caps.x402}, mpp=${caps.mpp}, services=${profile.selfDeclared.services.length}.`;

      return toolResult(text, {
        profile,
        agentCard: selfDeclared(card),
        recentFeedback: selfDeclared(recent),
        verification,
      });
    }),
  );
}
