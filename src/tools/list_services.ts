/**
 * list_services — flat, filterable catalog of self-declared x402/MPP service
 * endpoint candidates.
 *
 * Each row is one owner-declared endpoint candidate with its owning agent's
 * typed capability + trust + ranked-score context. `hasServices:true` is
 * forced. The server does not probe liveness, endpoint ownership, protocol
 * conformance, or payment behavior. Untrusted service text
 * (name/endpoint/version/description) is confined to a labeled `selfDeclared`
 * slot per row.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { NotFoundError, ValidationError } from "@trionlabs/stellar8004";
import { scoreAgent } from "../lib/ranking.js";
import { buildSelfDeclaredFields, safe, selfDeclared, serverText } from "../lib/sanitize.js";
import type { GetAgentsParams } from "../lib/explorer.js";
import {
  agentIds,
  canonicalTrust,
  deriveCapabilities,
  handler,
  mapWithConcurrency,
  MAX_QUERY_LENGTH,
  toolResult,
  toRankInput,
  zLimit,
  zLegacyMinScore,
  zMinExplorerScore,
  zTrust,
  READ_ANNOTATIONS,
  type ToolDeps,
} from "./shared.js";
import { zDiscoveryCoverage, zSelfDeclaredSlot } from "./schemas.js";

const CANDIDATE_PAGE_SIZE = 50;

const inputShape = {
  search: z.string().max(MAX_QUERY_LENGTH).optional().describe("Free-text filter over agent name/description."),
  x402: z.literal(true).optional().describe("When present, only x402 (USDC pay-per-call) services."),
  mpp: z.literal(true).optional().describe("When present, only MPP micropayment services."),
  trust: zTrust.optional(),
  minExplorerScore: zMinExplorerScore.optional().describe(
    "Minimum upstream v1 Explorer total_score in protocol units; not local rank.",
  ),
  minScore: zLegacyMinScore
    .optional()
    .describe("Deprecated ambiguous input; rejected. Use minExplorerScore."),
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
    capabilitiesVerified: z.literal(false),
    supportedTrust: z.array(z.string()),
    trustVerified: z.literal(false),
    score: z.number(),
    rankVersion: z.string(),
    evidenceStrength: z.number(),
    flags: z.record(z.string(), z.any()),
    endpointVerified: z.literal(false),
    livenessVerified: z.literal(false),
    protocolConformanceVerified: z.literal(false),
    paymentVerified: z.literal(false),
    service: zSelfDeclaredSlot,
  })
  .passthrough();

const outputShape = {
  count: z.number(),
  page: z.number(),
  services: z.array(zServiceRow),
  coverage: zDiscoveryCoverage,
};

export function registerListServices(server: McpServer, deps: ToolDeps): void {
  const maxLimit = Math.max(1, Math.min(50, deps.policy?.maxListServicesLimit ?? 50));
  const maxPage = Math.max(1, deps.policy?.maxListServicesPage ?? Number.MAX_SAFE_INTEGER);
  const runtimeInputShape = {
    ...inputShape,
    limit: zLimit(Math.min(20, maxLimit), maxLimit),
    page: z.number().int().min(1).max(maxPage).default(1),
  };
  server.registerTool(
    "list_services",
    {
      title: "List Services",
      description:
        "Catalog of self-declared service endpoint candidates, each with its owning agent's indexed " +
        "owner-declared capability/trust signals and ranked score. Filter by x402/mpp/trust/minExplorerScore/search. " +
        "No endpoint is probed for liveness, ownership, protocol conformance, or payment behavior. " +
        "Service labels/endpoints are unverified and live in each row's labeled `selfDeclared` slot.",
      inputSchema: z.object(runtimeInputShape),
      outputSchema: z.object(outputShape),
      annotations: { title: "List Services", ...READ_ANNOTATIONS },
    },
    handler<Args>(async (args) => {
      if (args.minScore !== undefined) {
        throw new ValidationError(
          "minScore is ambiguous and no longer supported; use minExplorerScore for the upstream v1 Explorer total_score filter.",
        );
      }
      const filters: Omit<NonNullable<GetAgentsParams>, "search" | "page"> = {
        hasServices: true,
        // neededPages below is calculated against this exact server page size.
        limit: CANDIDATE_PAGE_SIZE,
      };
      if (args.x402 !== undefined) filters.x402 = args.x402;
      if (args.mpp !== undefined) filters.mpp = args.mpp;
      if (args.trust !== undefined) filters.trust = canonicalTrust(args.trust);
      if (args.minExplorerScore !== undefined) filters.minScore = args.minExplorerScore;

      // Discover via the same stem-matching primitive find_agent uses: the
      // explorer `search=` substring param misses "Scrapper" for "scraper". Fetch
      // enough candidate pages to cover the requested `page` offset below.
      const neededPages = Math.min(
        10,
        Math.ceil((args.page * args.limit) / CANDIDATE_PAGE_SIZE) + 1,
      );
      const discovery = await deps.explorer.findAgentsWithCoverage(args.search ?? "", {
        filters,
        pages: neededPages,
        match: "any",
      });
      const pool = discovery.agents;

      // Score declared-only (fast) and order agents by score before fan-out.
      const scored = pool
        .map((a) => ({
          a,
          result: scoreAgent(toRankInput(a), {
            scoreMax: deps.config.scoreMax,
          }),
        }))
        .sort((x, y) => y.result.score100 - x.result.score100);

      // `page` selects a window of `limit` agents over the score-ranked pool.
      // The explorer LIST endpoint omits services[] AND metadata (both live only
      // in the per-agent detail), so hydrate the windowed agents via getAgent(id) —
      // otherwise every row would carry zero endpoint candidates. MPP is already
      // filtered by the list endpoint, so only the requested agent window needs
      // hydration rather than a wider client-side MPP probe window.
      const offset = (args.page - 1) * args.limit;
      const head = scored.slice(offset, offset + args.limit);
      let hydrationMissing = 0;
      const hydrated = await mapWithConcurrency(
        head,
        deps.policy?.maxExplorerConcurrency ?? 6,
        ({ a }) =>
          deps.explorer
            .getAgent(a.id)
            .then((r) => r.data)
            .catch((error: unknown) => {
              // A row can disappear between list and detail reads. Skip that
              // explicit race, but never turn an outage/timeout/authorization
              // failure into a plausible-looking agent with zero services.
              if (error instanceof NotFoundError) {
                hydrationMissing++;
                return null;
              }
              throw error;
            }),
      );

      let pairs = head
        .map((s, i) => (hydrated[i] ? { a: hydrated[i]!, result: s.result } : null))
        .filter((pair): pair is NonNullable<typeof pair> => pair !== null);
      pairs = pairs.slice(0, args.limit);

      const rows = [];
      let agentsWithServices = 0; // count only agents that actually contribute a row
      for (const { a, result } of pairs) {
        const services = buildSelfDeclaredFields({ services: a.services ?? null }).services;
        if (services.length === 0) continue;
        agentsWithServices++;
        const caps = deriveCapabilities(a);
        const ids = agentIds(deps.config, a.id);
        for (const svc of services) {
          rows.push({
            agentId: a.id,
            stellarId: ids.stellarId,
            caip2Id: ids.caip2Id,
            capabilities: { x402: caps.x402, mpp: caps.mpp },
            capabilitiesVerified: false as const,
            supportedTrust: caps.supportedTrust,
            trustVerified: false as const,
            score: result.score100,
            rankVersion: result.rankVersion,
            evidenceStrength: result.evidenceStrength,
            flags: {
              unrated: result.flags.unrated,
              newAgent: result.flags.newAgent,
              lowEvidence: result.flags.lowEvidence,
              lowConfidence: result.flags.lowConfidence,
            },
            endpointVerified: false as const,
            livenessVerified: false as const,
            protocolConformanceVerified: false as const,
            paymentVerified: false as const,
            service: selfDeclared(svc),
          });
        }
      }

      const text = serverText`${rows.length} self-declared service candidate(s) across ${agentsWithServices} agent(s) on ${safe(
        deps.config.network,
      )} (page ${args.page}). Liveness, ownership, protocol conformance, and payment behavior were not verified.`;

      // The list response and each detail hydration are independent v1 reads
      // with no shared revision/cursor. Even a one-page list cannot make the
      // resulting join snapshot-complete after detail hydration.
      const hydrationUnversioned = head.length > 0;
      const limitations = [
        ...(discovery.coverage.limitations ?? []),
        ...(hydrationUnversioned ? ["detail-hydration-unversioned"] : []),
      ];

      return toolResult(text, {
        count: rows.length,
        page: args.page,
        services: rows,
        coverage: {
          ...discovery.coverage,
          coverageComplete:
            discovery.coverage.coverageComplete &&
            hydrationMissing === 0 &&
            !hydrationUnversioned,
          snapshotConsistent:
            discovery.coverage.snapshotConsistent && !hydrationUnversioned,
          hydrationMissing,
          detailsHydrated: head.length,
          ...(limitations.length > 0 ? { limitations: [...new Set(limitations)] } : {}),
        },
      });
    }),
  );
}
