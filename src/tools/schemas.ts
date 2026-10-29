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
    lowEvidence: z.boolean(),
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
    status: z.enum(["verified", "partial", "mismatch", "unavailable", "skipped"]),
    declared: z.record(z.string(), z.any()),
    snapshotComparable: z.literal(false),
    limitations: z.array(z.string()),
    verified: z.record(z.string(), z.any()).optional(),
    deltas: z.record(z.string(), z.any()).optional(),
    checkedAt: z.string(),
    reason: z.string().optional(),
    verifiedFields: z.array(z.string()).optional(),
    unverifiedFields: z.array(z.string()).optional(),
  })
  .passthrough();

/** Full 3-axis breakdown — permissive record (numbers + nested axes + flags). */
export const zBreakdown = z.record(z.string(), z.any());

export const zRankedAgent = z
  .object({
    id: z.number(),
    rank: z.number(),
    score: z.number(),
    rankVersion: z.string(),
    evidenceStrength: z.number(),
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
    selfDeclared: z.record(z.string(), z.any()),
  })
  .passthrough();

export const zInterpretedQuery = z
  .object({
    keywords: z.array(z.string()),
    filters: z.record(z.string(), z.any()),
    matched: z.array(z.string()),
    unsupported: z.array(z.string()),
  })
  .passthrough();

/** Registry-mode disclosure (lib/source.ts RegistrySourceNote); absent in explorer mode. */
export const zSourceNote = z
  .object({
    kind: z.literal("registry"),
    allowlistSize: z.number().int().nonnegative(),
    reputationIndexed: z.literal(false),
    note: z.string(),
  })
  .passthrough();

/** A rule a Provider Standard manifest or its declaration breaks; messages are server-authored. */
export const zManifestProblem = z
  .object({
    rule: z.string().optional().describe("Provider Standard v1 rule id, e.g. M3, P1, I1."),
    message: z.string(),
  })
  .passthrough();

/** The checked, typed terms of a Provider Standard v1 manifest (get_provider_manifest). */
export const zProviderOffer = z
  .object({
    payment: z
      .object({
        protocol: z.literal("x402"),
        x402Version: z.literal(2),
        scheme: z.literal("exact"),
        network: z.enum(["stellar:testnet", "stellar:pubnet"]),
        asset: z.string().describe("The USDC Stellar Asset Contract for the network."),
        assetSymbol: z.literal("USDC"),
        payTo: z.string().describe("Checksummed G… or C… address the manifest says receives payment."),
        maxTimeoutSeconds: z.number().int(),
        feesSponsored: z.literal(true),
      })
      .passthrough(),
    recovery: z
      .object({
        retentionSeconds: z.number().int().describe("How long results stay collectable without paying again."),
        retentionDefaulted: z.boolean(),
      })
      .passthrough(),
    dataUse: z
      .object({ storesInputs: z.boolean().nullable(), trainsOnInputs: z.boolean().nullable() })
      .passthrough(),
    services: z.array(
      z
        .object({
          name: z.string(),
          price: z
            .object({
              amount: z.string().describe("Base units, exactly as the manifest states them."),
              asset: z.literal("USDC"),
              decimals: z.number().int(),
              usdc: z.string().describe("The same amount in whole USDC."),
            })
            .passthrough(),
          charge: z.enum(["on-success", "upfront"]),
          expectedDurationSeconds: z.number().int().nullable(),
          maxInputBytes: z.number().int(),
          capacity: z
            .object({ concurrency: z.number().int().nullable(), maxQueueWaitSeconds: z.number().int().nullable() })
            .passthrough()
            .nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** [I1]–[I3]: whether the manifest is bound to the agent's on-chain registration and wallet. */
export const zIdentityBinding = z
  .object({
    status: z.enum(["bound", "not-bound", "unverified"]),
    registration: z.enum(["onchain", "indexed"]),
    checks: z.array(
      z
        .object({
          rule: z.enum(["I1", "I2", "I3"]),
          status: z.enum(["pass", "fail", "unverified"]),
          message: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const zValidationRecord = z
  .object({
    requestHash: z.string(),
    validator: z.string(),
    trusted: z.boolean(),
    selfValidated: z.boolean(),
    response: z.number().int(),
    level: z.number().int().nullable(),
    responseHash: z.string(),
    ledger: z.number().int(),
  })
  .passthrough();

/** Provider Standard conformance from trusted validators' Validation Registry records. */
export const zConformance = z
  .object({
    status: z.enum(["attested", "none", "not-configured", "unavailable"]),
    tag: z.string(),
    trustedValidators: z.number().int().nonnegative(),
    trustedRecordCount: z.number().int().nonnegative().nullable(),
    level: z.number().int().nullable(),
    badges: z.array(
      z
        .object({
          id: z.enum(["standard-v1", "payment-verified", "recovery-verified"]),
          label: z.string(),
          network: z.string(),
        })
        .passthrough(),
    ),
    latest: zValidationRecord.nullable(),
    records: z.array(zValidationRecord),
    limitations: z.array(z.string()),
    reason: z.string().optional(),
  })
  .passthrough();

/** Bounded-discovery coverage; `hasMore` is omitted when the API cannot derive it. */
export const zDiscoveryCoverage = z
  .object({
    coverageComplete: z.boolean(),
    paginationExhausted: z.boolean(),
    snapshotConsistent: z.boolean(),
    pagesScanned: z.number().int().nonnegative(),
    recordsScanned: z.number().int().nonnegative(),
    hasMore: z.boolean().optional(),
    limitations: z.array(z.string()).optional(),
  })
  .passthrough();
