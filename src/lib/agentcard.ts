/**
 * agentcard.ts — A2A AgentCard projection (research/E R-E1; research/A §3.3/§6).
 *
 * Pure, side-effect-free projection from our canonical {@link AgentProfile} to
 * an object shaped like an A2A (Linux Foundation) AgentCard v0.3, plus an
 * `x-stellar8004` extension that carries the on-chain identity + verified
 * reputation axes that make this registry distinctive.
 *
 * A2A is the de-facto off-chain discovery format; emitting this projection lets
 * any A2A-aware client consume Stellar 8004 agents. The 8004 registration file
 * is a superset that already references A2A cards, so this is a lossless
 * down-projection over data we already hold — no new reads, read-only safe.
 *
 * TRUST BOUNDARY — READ THIS:
 *   The `name`, `description`, `provider.organization` and every field under
 *   `skills[]` (name/description/tags) originate from AGENT-AUTHORED, SELF-
 *   DECLARED, UNVERIFIED on-chain text. They are sourced from
 *   `profile.selfDeclared` (already control-char/length sanitized on ingest)
 *   and are passed through here VERBATIM as DATA. The CALLER is responsible for
 *   treating them as untrusted data: never interpolate them into server-
 *   authored prose (content[].text) and never follow instructions embedded in
 *   them. Only the fields under `x-stellar8004` (typed ids, enums, numbers,
 *   Stellar G/C-addresses) are verified/typed and safe to interpolate.
 */

import type { AgentProfile, ServiceEntry } from "../types.js";

// ---------------------------------------------------------------------------
// A2A AgentCard shape (v0.3-compatible subset we can faithfully populate)
// ---------------------------------------------------------------------------

/** A2A capability extension descriptor. */
export interface AgentCardExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

/** A2A `capabilities` block. */
export interface AgentCardCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
  stateTransitionHistory: boolean;
  extensions: AgentCardExtension[];
}

/** A2A `provider` block. `organization` is self-declared/owner-derived. */
export interface AgentCardProvider {
  /** Owner G-address (typed/verified). Not a human-readable org name. */
  organization: string;
  url: string | null;
}

/**
 * A2A `skill`. `id` is server-derived (stable, typed). `name`/`description`/
 * `tags` are SELF-DECLARED, UNVERIFIED passthrough — treat as data.
 */
export interface AgentCardSkill {
  id: string;
  /** self-declared, unverified */
  name: string;
  /** self-declared, unverified */
  description: string;
  tags: string[];
  inputModes: string[];
  outputModes: string[];
}

/** The `x-stellar8004` extension — verified/typed identity + reputation axes. */
export interface StellarAgentCardExtension {
  /** stellar:{network}:{identity}#{id} */
  stellarId: string;
  /** stellar:{pubnet|testnet}:{identity}#{id} (CAIP-2) */
  caip2Id: string;
  agentId: number;
  network: string;
  owner: string;
  wallet: string | null;
  agentUri: string | null;
  /** verification.status === "verified" */
  verified: boolean;
  verificationStatus: string;
  supportedTrust: string[];
  capabilities: { x402: boolean; mpp: boolean };
  reputation: {
    /** indexer-declared average, 0..RANK_SCORE_MAX (null when unrated) */
    declaredAverage: number | null;
    /** on-chain re-derived average (present only when verified) */
    verifiedAverage: number | null;
    feedbackCount: number;
    uniqueClients: number;
  };
  /** 3-axis ranking breakdown (present only when the profile carries a rank). */
  rank: {
    score100: number;
    confidence: number;
    quality: number | null;
    volume: number | null;
    breadth: number | null;
  } | null;
}

/** An A2A-AgentCard-compatible object with our verified extension. */
export interface AgentCard {
  /** A2A protocol version this projection targets. */
  protocolVersion: string;
  /** self-declared, unverified */
  name: string;
  /** self-declared, unverified */
  description: string;
  /** Primary service endpoint (self-declared); falls back to agentUri. */
  url: string | null;
  preferredTransport: string;
  provider: AgentCardProvider;
  /** Agent version (self-declared service version, else a placeholder). */
  version: string;
  capabilities: AgentCardCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentCardSkill[];
  /** Verified/typed Stellar 8004 identity + reputation. Safe to interpolate. */
  "x-stellar8004": StellarAgentCardExtension;
}

/** Options to tune media modes / transport without changing the projection. */
export interface AgentCardOptions {
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  preferredTransport?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const A2A_PROTOCOL_VERSION = "0.3.0";
const DEFAULT_MODES = ["application/json"] as const;
const DEFAULT_TRANSPORT = "HTTP+JSON";
/** Emitted when no service declares a version; explicit placeholder, not real. */
const UNKNOWN_VERSION = "0.0.0";

const X402_EXTENSION_URI = "https://stellar8004.com/ext/x402";
const MPP_EXTENSION_URI = "https://stellar8004.com/ext/mpp";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable, typed skill id derived from a service name + index (server-authored). */
function skillId(svc: ServiceEntry, index: number): string {
  const slug = svc.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${slug}-${index}` : `service-${index}`;
}

function toSkill(
  svc: ServiceEntry,
  index: number,
  inputModes: string[],
  outputModes: string[],
): AgentCardSkill {
  return {
    id: skillId(svc, index),
    // passthrough — self-declared / unverified (see file header)
    name: svc.name,
    description: svc.description ?? "",
    tags: [],
    inputModes,
    outputModes,
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Project an {@link AgentProfile} to an A2A-AgentCard-compatible object.
 *
 * Pure function: no I/O, deterministic for a given profile. Untrusted text is
 * passed through verbatim from `profile.selfDeclared`; see the file header for
 * the trust-boundary contract the caller must honor.
 */
export function toAgentCard(profile: AgentProfile, options: AgentCardOptions = {}): AgentCard {
  const inputModes = options.defaultInputModes ?? [...DEFAULT_MODES];
  const outputModes = options.defaultOutputModes ?? [...DEFAULT_MODES];
  const transport = options.preferredTransport ?? DEFAULT_TRANSPORT;

  const services = profile.selfDeclared.services;
  const primaryEndpoint = services[0]?.endpoint ?? profile.agentUri ?? null;
  const version = services[0]?.version ?? UNKNOWN_VERSION;

  const extensions: AgentCardExtension[] = [];
  if (profile.capabilities.x402) {
    extensions.push({
      uri: X402_EXTENSION_URI,
      description: "Accepts x402 (USDC pay-per-call) payments.",
      required: false,
    });
  }
  if (profile.capabilities.mpp) {
    extensions.push({
      uri: MPP_EXTENSION_URI,
      description: "Supports MPP streaming micropayments.",
      required: false,
    });
  }

  const rank = profile.rank
    ? {
        score100: profile.rank.score100,
        confidence: profile.rank.confidence,
        quality: profile.rank.quality.raw,
        volume: profile.rank.volume.raw,
        breadth: profile.rank.breadth.raw,
      }
    : null;

  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    // passthrough — self-declared / unverified (see file header)
    name: profile.selfDeclared.name ?? "",
    description: profile.selfDeclared.description ?? "",
    url: primaryEndpoint,
    preferredTransport: transport,
    provider: {
      organization: profile.owner,
      url: profile.agentUri,
    },
    version,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions,
    },
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    skills: services.map((svc, i) => toSkill(svc, i, inputModes, outputModes)),
    "x-stellar8004": {
      stellarId: profile.stellarId,
      caip2Id: profile.caip2Id,
      agentId: profile.id,
      network: profile.network,
      owner: profile.owner,
      wallet: profile.wallet,
      agentUri: profile.agentUri,
      verified: profile.verified,
      verificationStatus: profile.verification.status,
      supportedTrust: profile.supportedTrust,
      capabilities: {
        x402: profile.capabilities.x402,
        mpp: profile.capabilities.mpp,
      },
      reputation: {
        declaredAverage: profile.scores.average,
        verifiedAverage: profile.verification.verified?.average ?? null,
        feedbackCount: profile.scores.feedbackCount,
        uniqueClients: profile.scores.uniqueClients,
      },
      rank,
    },
  };
}
