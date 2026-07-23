/**
 * resolve_agent — turn any agent reference (numeric id, numeric string, full
 * stellar:{network}:{identity}#{id} handle, or owner G-address) into the
 * canonical typed identifiers. Owner addresses expand to every agent they own
 * (needs an explorer lookup); all other kinds resolve without I/O.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ValidationError } from "@trionlabs/stellar8004";
import { parseAgentRef } from "../lib/identifier.js";
import {
  agentIds,
  handler,
  toolResult,
  READ_ANNOTATIONS,
  type ToolDeps,
} from "./shared.js";
import { safe, sanitizeText, serverText } from "../lib/sanitize.js";

const inputShape = {
  ref: z
    .union([z.number().int().nonnegative(), z.string().min(1)])
    .describe("Agent id, numeric string, stellar:{network}:{identity}#{id} handle, or owner G-address."),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const zResolved = z
  .object({ id: z.number(), stellarId: z.string(), caip2Id: z.string() })
  .passthrough();

const outputShape = {
  kind: z.enum(["id", "stellarId", "owner"]),
  network: z.string(),
  owner: z.string().nullable(),
  count: z.number(),
  agents: z.array(zResolved),
};

export function registerResolveAgent(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "resolve_agent",
    {
      title: "Resolve Agent",
      description:
        "Resolve any agent reference (id, numeric string, stellar handle, or owner G-address) to the " +
        "canonical typed identifiers (numeric id + stellar + CAIP-2). Owner addresses expand to all " +
        "agents they own.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { title: "Resolve Agent", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      let parsed;
      try {
        parsed = parseAgentRef(args.ref);
      } catch (err) {
        throw new ValidationError(err instanceof Error ? err.message : "Invalid agent reference.");
      }

      if (parsed.kind === "owner") {
        const agents = (await deps.explorer.getAgentsByOwner(parsed.address)).data ?? [];
        const resolved = agents.map((a) => ({ id: a.id, ...agentIds(deps.config, a.id) }));
        const text = serverText`Owner resolves to ${resolved.length} agent(s) on ${safe(
          deps.config.network,
        )}.`;
        return toolResult(text, {
          kind: "owner",
          network: deps.config.network,
          owner: sanitizeText(parsed.address, 60),
          count: resolved.length,
          agents: resolved,
        });
      }

      const ids = agentIds(deps.config, parsed.id);
      const text = serverText`Resolved to agent ${parsed.id} on ${safe(deps.config.network)}.`;
      return toolResult(text, {
        kind: parsed.kind,
        network: deps.config.network,
        owner: null,
        count: 1,
        agents: [{ id: parsed.id, ...ids }],
      });
    }),
  );
}
