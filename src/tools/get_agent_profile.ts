/**
 * get_agent_profile — deep profile for one agent: typed identity + capabilities
 * + scores + 3-axis breakdown + declared-vs-verified reputation + recent
 * feedback + the canonical stellar identifier + an explicitly unverified,
 * derived A2A-shaped projection.
 *
 * Trust boundary: all agent-authored free text (name/description/services/
 * metadata/image) is confined to `profile.selfDeclared`; the derived projection
 * and feedback (both carry untrusted text) are emitted inside labeled
 * `selfDeclared` slots. content[].text interpolates only typed/enum/numeric values.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ValidationError } from "@trionlabs/stellar8004";
import { MAX_AGENT_ID, resolveAgentId, STELLAR_ID_RE } from "../lib/identifier.js";
import { toAgentCard } from "../lib/agentcard.js";
import { safe, selfDeclared, serverText } from "../lib/sanitize.js";
import {
  buildAgentProfile,
  collectFeedbackWindow,
  handler,
  toolResult,
  toSafeFeedback,
  READ_ANNOTATIONS,
  type ToolDeps,
} from "./shared.js";
import { zAgentProfile, zSelfDeclaredSlot, zVerification } from "./schemas.js";

const inputShape = {
  agent: z
    .union([
      z.number().int().nonnegative().max(MAX_AGENT_ID),
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
  feedbackCoverage: z
    .object({
      windowComplete: z.boolean(),
      paginationExhausted: z.boolean(),
      pagesScanned: z.number().int().nonnegative(),
      hasMore: z.boolean().optional(),
    })
    .passthrough(),
  verification: zVerification,
};

export function registerGetAgentProfile(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_agent_profile",
    {
      title: "Get Agent Profile",
      description:
        "Full profile for one agent: typed identity, capabilities, declared scores, a 3-axis rank " +
        "breakdown, a bounded declared-vs-on-chain reputation check, recent feedback, the canonical " +
        "stellar:{network}:{identity}#{id} handle, and an explicitly unverified derived A2A-shaped " +
        "projection. No A2A conformance or endpoint ownership is implied; self-declared text is " +
        "confined to labeled `selfDeclared` slots.",
      inputSchema: z.object(inputShape),
      outputSchema: z.object(outputShape),
      annotations: { title: "Get Agent Profile", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const id = resolveAgentId(args.agent, {
        network: deps.config.network,
        identity: deps.config.stellar.contracts.identity,
      });
      if (id == null) {
        throw new ValidationError(`Could not resolve agent reference '${String(args.agent)}'.`);
      }

      // Fetch detail and feedback concurrently: feedback depends only on `id`, so
      // firing it up front overlaps it with the slow multi-RPC on-chain verify
      // (which buildAgentProfile runs) instead of serializing behind it.
      const detailPromise = deps.explorer.getAgent(id);
      const feedbackPromise =
        args.feedbackLimit > 0
          ? collectFeedbackWindow(deps, id, {
              page: 1,
              limit: args.feedbackLimit,
              includeRevoked: false,
            })
          : Promise.resolve({
              rows: [],
              revokedHidden: 0,
              coverage: { windowComplete: true, paginationExhausted: false, pagesScanned: 0 },
            });
      const detailRes = await detailPromise;
      // Verification starts as soon as detail is available and overlaps the
      // still-running multi-page feedback scan.
      const [built, feedbackWindow] = await Promise.all([
        buildAgentProfile(deps, id, { verify: args.verify, detail: detailRes.data }),
        feedbackPromise,
      ]);
      const { profile, verification, caps, declared } = built;
      const rank = profile.rank!; // buildAgentProfile always sets it

      // Recent feedback: drop revoked, cap to feedbackLimit, sanitize + label.
      const recent = feedbackWindow.rows.map(toSafeFeedback);

      const card = toAgentCard(profile);

      const avg = declared.average;
      const text = serverText`Agent ${id} on ${safe(deps.config.network)}: reputation ${safe(
        verification.status,
      )}, declared avg ${avg == null ? safe("n/a") : avg} over ${declared.feedbackCount} feedback(s), ${
        declared.uniqueClients
      } unique client(s). Score ${rank.score100}/100, confidence ${Math.round(
        rank.confidence * 100,
      )}%. x402=${caps.x402}, mpp=${caps.mpp}, services=${profile.selfDeclared.services.length}.`;

      return toolResult(text, {
        profile,
        agentCard: selfDeclared(card),
        recentFeedback: selfDeclared(recent),
        feedbackCoverage: feedbackWindow.coverage,
        verification,
      });
    }),
  );
}
