/**
 * get_agent_card — an explicitly unverified A2A-shaped projection for one agent,
 * as a first-class tool (also available via the stellar8004://agent/{id}/card
 * resource and embedded in get_agent_profile).
 *
 * No agent-published A2A document is fetched or validated. The projection must
 * not be consumed as a protocol-conformance or endpoint-ownership proof. Every
 * owner-authored value remains under `card.selfDeclared`; standard-shaped fields
 * are neutral/null/empty. content[].text is typed-only.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ValidationError } from "@trionlabs/stellar8004";
import { MAX_AGENT_ID, resolveAgentId, STELLAR_ID_RE } from "../lib/identifier.js";
import { toAgentCard } from "../lib/agentcard.js";
import { safe, serverText } from "../lib/sanitize.js";
import {
  buildAgentProfile,
  handler,
  toolResult,
  READ_ANNOTATIONS,
  type ToolDeps,
} from "./shared.js";

const inputShape = {
  agent: z
    .union([
      z.number().int().nonnegative().max(MAX_AGENT_ID),
      z.string().max(256).regex(STELLAR_ID_RE, "stellar:{network}:{identity}#{id}"),
      z.string().max(256).regex(/^\d+$/, "numeric agent id"),
    ])
    .describe("Numeric agent id, numeric string, or a full stellar:{network}:{identity}#{id} handle."),
  verify: z
    .boolean()
    .default(false)
    .describe(
      "Attempt the bounded Reputation-contract reachability probe; it does not verify reputation fields, A2A conformance, or endpoints.",
    ),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const NOTE =
  "UNVERIFIED DERIVED PROJECTION, not an agent-published or protocol-conformant A2A AgentCard. " +
  "No A2A document, endpoint ownership, transport, skill, or payment requirement was verified. " +
  "All agent-authored metadata and service candidates live only under `card.selfDeclared`. " +
  "`x-stellar8004.verificationScope` is reachability-only; current reputation fields remain Explorer-declared.";

const outputShape = {
  // The derived A2A-shaped object (see lib/agentcard.ts for the exact shape).
  // Kept permissive so provenance extensions pass structuredContent validation.
  card: z.record(z.string(), z.any()),
  conformance: z.literal("unverified-derived"),
  note: z.string(),
};

export function registerGetAgentCard(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_agent_card",
    {
      title: "Get Derived A2A Projection",
      description:
        "Unverified A2A-shaped projection from indexed Stellar 8004 metadata. It is not an " +
        "agent-published AgentCard and proves neither A2A conformance nor endpoint ownership. " +
        "Owner-authored metadata and service candidates are isolated under `card.selfDeclared`.",
      inputSchema: z.object(inputShape),
      outputSchema: z.object(outputShape),
      annotations: { title: "Get Derived A2A Projection", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const id = resolveAgentId(args.agent, {
        network: deps.config.network,
        identity: deps.config.stellar.contracts.identity,
      });
      if (id == null) {
        throw new ValidationError(`Could not resolve agent reference '${String(args.agent)}'.`);
      }

      const { profile } = await buildAgentProfile(deps, id, { verify: args.verify });
      const card = toAgentCard(profile);
      const ext = card["x-stellar8004"];

      const declared = card.selfDeclared.capabilities;
      const text = serverText`Unverified derived A2A-shaped projection for agent ${id} on ${safe(
        deps.config.network,
      )}: conformance=${safe(card.conformance)}, endpointVerified=${card.provenance.endpointOwnershipVerified}, declaredX402=${
        declared.x402
      }, declaredMpp=${declared.mpp}, reputationVerified=${ext.verified} (${safe(
        ext.verificationStatus,
      )}). Service candidates remain self-declared and are not invokable A2A endpoints.`;

      return toolResult(text, { card, conformance: card.conformance, note: NOTE });
    }),
  );
}
