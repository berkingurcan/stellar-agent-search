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
      const filters: Omit<NonNullable<GetAgentsParams>, "search" | "page"> = {
        hasServices: true,
      };
      if (args.x402 !== undefined) filters.x402 = args.x402;
      if (args.trust !== undefined) filters.trust = args.trust;
      if (args.minScore !== undefined) filters.minScore = args.minScore;

      // Discover via the same stem-matching primitive find_agent uses: the
      // explorer `search=` substring param misses "Scrapper" for "scraper".
      const pool = await deps.explorer.findAgents(args.search ?? "", {
        filters,
        pages: 2,
        match: "any",
      });

      // Score declared-only (fast) and order agents by score before fan-out.
      const scored = pool
        .map((a) => ({
          a,
          result: scoreAgent(toRankInput(a), {
            weights: deps.config.weights,
            scoreMax: deps.config.scoreMax,
          }),
        }))
        .sort((x, y) => y.result.score100 - x.result.score100);

      // The explorer LIST endpoint omits services[] AND metadata (both live only
      // in the per-agent detail), so hydrate the top agents via getAgent(id) —
      // otherwise every row would carry zero callable endpoints. When `mpp` is
      // requested we hydrate a wider head so we can filter on the detail-only MPP
      // signal AFTER hydration (filtering list rows would drop everything).
      const headCount = args.mpp ? Math.min(scored.length, args.limit * 3) : args.limit;
      const head = scored.slice(0, headCount);
      const hydrated = await Promise.all(
        head.map(({ a }) =>
          deps.explorer
            .getAgent(a.id)
            .then((r) => r.data)
            .catch(() => a),
        ),
      );

      let pairs = head.map((s, i) => ({ a: hydrated[i] ?? s.a, result: s.result }));
      if (args.mpp) pairs = pairs.filter(({ a }) => deriveCapabilities(a).mpp);
      pairs = pairs.slice(0, args.limit);

      const rows = [];
      for (const { a, result } of pairs) {
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

      const text = serverText`${rows.length} service(s) across ${pairs.length} agent(s) on ${safe(
        deps.config.network,
      )} (page ${args.page}).`;

      return toolResult(text, { count: rows.length, page: args.page, services: rows });
    }),
  );
}
