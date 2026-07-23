/**
 * list_services — flat, filterable catalog of invokable x402/MPP services.
 *
 * Each row is one callable endpoint with its owning agent's typed capability +
 * trust + ranked-score context. `hasServices:true` is forced. Untrusted service
 * text (name/endpoint/version/description) is confined to a labeled
 * `selfDeclared` slot per row. This is the menu the x402 loop picks from.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { scoreAgent } from "../lib/ranking.js";
import { buildSelfDeclaredFields, safe, selfDeclared, serverText } from "../lib/sanitize.js";
import type { GetAgentsParams } from "../lib/explorer.js";
import {
  agentIds,
  deriveCapabilities,
  handler,
  toolResult,
  toRankInput,
  zLimit,
  zMinScore,
  zTrust,
  READ_ANNOTATIONS,
  type ToolDeps,
} from "./shared.js";
import { zSelfDeclaredSlot } from "./schemas.js";

const inputShape = {
  search: z.string().optional().describe("Free-text filter over agent name/description."),
  x402: z.boolean().optional().describe("Only x402 (USDC pay-per-call) services."),
  mpp: z.boolean().optional().describe("Only MPP micropayment services (filtered client-side)."),
  trust: zTrust.optional(),
  minScore: zMinScore.optional(),
  limit: zLimit(20),
  page: z.number().int().min(1).default(1),
};

type Args = z.infer<z.ZodObject<typeof inputShape>>;

const zServiceRow = z
  .object({
    agentId: z.number(),
    stellarId: z.string(),
    caip2Id: z.string(),
    capabilities: z.object({ x402: z.boolean(), mpp: z.boolean() }).passthrough(),
    supportedTrust: z.array(z.string()),
    score: z.number(),
    flags: z.record(z.any()),
    service: zSelfDeclaredSlot,
  })
  .passthrough();

const outputShape = {
  count: z.number(),
  page: z.number(),
  services: z.array(zServiceRow),
};

export function registerListServices(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_services",
    {
      title: "List Services",
      description:
        "Catalog of invokable services (callable endpoints), each with its owning agent's typed " +
        "capability, trust model, and ranked score. Filter by x402/mpp/trust/minScore/search. " +
        "Service labels/endpoints are self-declared (unverified) and live in each row's labeled " +
        "`selfDeclared` slot.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { title: "List Services", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      const params: GetAgentsParams = {
        hasServices: true,
        page: args.page,
        limit: args.limit,
      };
      if (args.search) params.search = args.search;
      if (args.x402 !== undefined) params.x402 = args.x402;
      if (args.trust !== undefined) params.trust = args.trust;
      if (args.minScore !== undefined) params.minScore = args.minScore;

      let agents = (await deps.explorer.getAgents(params)).data ?? [];
      if (args.mpp) agents = agents.filter((a) => deriveCapabilities(a).mpp);

      // Score declared-only (fast) and order agents by score before fan-out.
      const scored = agents
        .map((a) => ({
          a,
          result: scoreAgent(toRankInput(a), {
            weights: deps.config.weights,
            scoreMax: deps.config.scoreMax,
          }),
        }))
        .sort((x, y) => y.result.score100 - x.result.score100);

      const rows = [];
      for (const { a, result } of scored) {
        const caps = deriveCapabilities(a);
        const ids = agentIds(deps.config, a.id);
        const services = buildSelfDeclaredFields({ services: a.services ?? null }).services;
        for (const svc of services) {
          rows.push({
            agentId: a.id,
            stellarId: ids.stellarId,
            caip2Id: ids.caip2Id,
            capabilities: { x402: caps.x402, mpp: caps.mpp },
            supportedTrust: caps.supportedTrust,
            score: result.score100,
            flags: {
              unrated: result.flags.unrated,
              newAgent: result.flags.newAgent,
              lowConfidence: result.flags.lowConfidence,
            },
            service: selfDeclared(svc),
          });
        }
      }

      const text = serverText`${rows.length} service(s) across ${scored.length} agent(s) on ${safe(
        deps.config.network,
      )} (page ${args.page}).`;

      return toolResult(text, { count: rows.length, page: args.page, services: rows });
    }),
  );
}
