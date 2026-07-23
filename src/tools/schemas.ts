/**
 * tools/schemas.ts — reusable zod fragments for tool OUTPUT schemas.
 *
 * These describe the shape of `structuredContent`. The MCP SDK validates the
 * returned structuredContent against the (normalized) object schema and only
 * checks success — it does not mutate the payload — so schemas are intentionally
 * permissive (nullable/optional, passthrough) to guarantee validation succeeds
 * while still advertising a useful shape in tools/list.
 *
 * No root-level oneOf/anyOf: every combinator lives inside a property (Claude
 * Code rejects root-level unions in tool schemas).
 */

import { z } from "zod";

export const zSelfDeclaredSlot = z
  .object({
    provenance: z.literal("self-declared"),
    verified: z.literal(false),
    note: z.string(),
    value: z.any(),
  })
  .passthrough();

export const zFlags = z
  .object({
    unrated: z.boolean(),
    newAgent: z.boolean(),
    lowConfidence: z.boolean(),
    verified: z.boolean(),
    verificationMismatch: z.boolean(),
  })
  .passthrough();

export const zCapabilities = z
  .object({
    x402: z.boolean(),
    mpp: z.boolean(),
    hasServices: z.boolean(),
    supportedTrust: z.array(z.string()),
  })
  .passthrough();

export const zScores = z
  .object({
    average: z.number().nullable(),
    total: z.number().nullable(),
    feedbackCount: z.number(),
    uniqueClients: z.number(),
  })
  .passthrough();

export const zVerification = z
  .object({
    status: z.enum(["verified", "mismatch", "unavailable", "skipped"]),
    declared: z.record(z.any()),
    verified: z.record(z.any()).optional(),
    deltas: z.record(z.any()).optional(),
    checkedAt: z.string(),
  })
  .passthrough();

/** Full 3-axis breakdown — permissive record (numbers + nested axes + flags). */
export const zBreakdown = z.record(z.any());

export const zRankedAgent = z
  .object({
    id: z.number(),
    rank: z.number(),
    score: z.number(),
    stellarId: z.string(),
    caip2Id: z.string(),
    network: z.string(),
    owner: z.string(),
    wallet: z.string().nullable(),
    capabilities: zCapabilities,
    supportedTrust: z.array(z.string()),
    scores: zScores,
    flags: zFlags,
    breakdown: zBreakdown.optional(),
    verification: zVerification.optional(),
    selfDeclared: zSelfDeclaredSlot,
  })
  .passthrough();

export const zAgentProfile = z
  .object({
    id: z.number(),
    stellarId: z.string(),
    caip2Id: z.string(),
    network: z.string(),
    owner: z.string(),
    wallet: z.string().nullable(),
    agentUri: z.string().nullable(),
    capabilities: zCapabilities,
    supportedTrust: z.array(z.string()),
    scores: zScores,
    verification: zVerification,
    verified: z.boolean(),
    flags: zFlags,
    rank: zBreakdown.optional(),
    createdAt: z.string().nullable(),
    txHash: z.string().nullable(),
    resolveStatus: z.string().nullable(),
    selfDeclared: z.record(z.any()),
  })
  .passthrough();

export const zInterpretedQuery = z
  .object({
    keywords: z.array(z.string()),
    filters: z.record(z.any()),
    matched: z.array(z.string()),
  })
  .passthrough();
