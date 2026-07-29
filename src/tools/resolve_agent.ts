/**
 * resolve_agent — turn any agent reference (numeric id, numeric string, full
 * stellar:{network}:{identity}#{id} handle, or owner G-address) into the
 * canonical typed identifiers. Owner addresses expand to every agent they own
 * (needs an explorer lookup); all other kinds resolve without I/O.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ValidationError } from "@trionlabs/stellar8004";
import { MAX_AGENT_ID, parseAgentRef } from "../lib/identifier.js";
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
    .union([z.number().int().nonnegative().max(MAX_AGENT_ID), z.string().min(1).max(256)])
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
  coverage: z
    .object({
      coverageComplete: z.boolean(),
      paginationExhausted: z.boolean(),
      snapshotConsistent: z.boolean(),
      pagesScanned: z.number(),
      recordsScanned: z.number(),
      hasMore: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
};

export function registerResolveAgent(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "resolve_agent",
    {
      title: "Resolve Agent",
      description:
        "Resolve any agent reference (id, numeric string, stellar handle, or owner G-address) to the " +
        "canonical typed identifiers (numeric id + stellar + CAIP-2). Owner addresses expand the " +
        "current owner API page (up to 20); coverage reports whether more rows may exist.",
      inputSchema: z.object(inputShape),
      outputSchema: z.object(outputShape),
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
        const response = await deps.explorer.getAgentsByOwner(parsed.address);
        const agents = response.data ?? [];
        const resolved = agents.map((a) => ({ id: a.id, ...agentIds(deps.config, a.id) }));
        const hasMore = response.meta?.pagination?.hasMore;
        const paginationExhausted = hasMore === false;
        const text = serverText`Owner resolves to ${resolved.length} agent(s) on ${safe(
          deps.config.network,
        )}.`;
        return toolResult(text, {
          kind: "owner",
          network: deps.config.network,
          owner: sanitizeText(parsed.address, 60),
          count: resolved.length,
          agents: resolved,
          coverage: {
            coverageComplete: paginationExhausted,
            paginationExhausted,
            snapshotConsistent: true,
            pagesScanned: 1,
            recordsScanned: resolved.length,
            ...(typeof hasMore === "boolean" ? { hasMore } : {}),
          },
        });
      }

      if (
        parsed.kind === "stellarId" &&
        (parsed.network !== deps.config.network ||
          parsed.identity !== deps.config.stellar.contracts.identity)
      ) {
        throw new ValidationError(
          `Stellar handle belongs to ${parsed.network}/${parsed.identity}, but this server is scoped to ` +
            `${deps.config.network}/${deps.config.stellar.contracts.identity}.`,
        );
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
