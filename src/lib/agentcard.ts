/**
 * agentcard.ts — unverified A2A-shaped registry projection.
 *
 * Pure, side-effect-free projection from our canonical {@link AgentProfile} to
 * an object shaped like an A2A (Linux Foundation) AgentCard v0.3. It is NOT an
 * agent-published AgentCard and is NOT evidence of A2A protocol conformance,
 * endpoint ownership, transport support, or payment safety.
 *
 * No A2A document is fetched here. Registry metadata is only indexed and
 * sanitized, so arbitrary service endpoints must remain candidates under the
 * explicit `selfDeclared` boundary. They are never promoted to top-level `url`,
 * `skills[]`, a transport capability, or an actionable x402 requirement.
 *
 * TRUST BOUNDARY — READ THIS:
 *   Every agent-authored value is emitted ONLY below `selfDeclared`, which also
 *   carries source + verification markers. Top-level A2A-shaped fields contain
 *   server-derived neutral values or null/empty values. `x-stellar8004` carries
 *   typed indexed identity and explicitly scoped reputation verification; its
 *   marker does not claim that the agent or endpoint is A2A-conformant.
 */

import type { AgentProfile, ServiceEntry } from "../types.js";

// ---------------------------------------------------------------------------
// A2A-shaped compatibility fields (intentionally incomplete/non-conformant)
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

/** A2A `provider` block. organization is the typed owner address, not an org claim. */
export interface AgentCardProvider {
  /** Owner G-address (typed/verified). Not a human-readable org name. */
  organization: string;
  url: string | null;
}

/** A2A skill shape. Derived projections intentionally emit an empty skills[]. */
export interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes: string[];
  outputModes: string[];
}

export type AgentCardConformance = "unverified-derived";

/** Machine-readable reason this projection must not be treated as a verified card. */
export interface AgentCardProvenance {
  source: "stellar8004-indexed-registration";
  a2aDocumentFetched: false;
  a2aProtocolConformanceVerified: false;
  endpointOwnershipVerified: false;
}

/** Agent-owner-authored/indexed metadata. Everything here is UNVERIFIED. */
export interface AgentCardSelfDeclared {
  source: "agent-owner-authored-indexed-metadata";
  verified: false;
  name: string | null;
  description: string | null;
  image: string | null;
  agentUri: string | null;
  wallet: string | null;
  services: ServiceEntry[];
  metadata: Record<string, string>;
  capabilities: { x402: boolean; mpp: boolean };
  supportedTrust: string[];
}

/** The `x-stellar8004` extension — typed identity + scoped reputation facts. */
export interface StellarAgentCardExtension {
  conformance: AgentCardConformance;
  provenance: AgentCardProvenance;
  /** stellar:{network}:{identity}#{id} */
  stellarId: string;
  /** stellar:{pubnet|testnet}:{identity}#{id} (CAIP-2) */
  caip2Id: string;
  agentId: number;
  network: string;
  owner: string;
  /** Deprecated compatibility keys: never promote unverified metadata here. */
  wallet: null;
  agentUri: null;
  /** Reputation-summary verification only; NOT agent/A2A/endpoint verification. */
  verified: boolean;
  verificationStatus: string;
  verificationScope: "reputation-summary-only";
  /** No trust model or protocol capability has been independently verified. */
  supportedTrust: string[];
  capabilities: { x402: boolean; mpp: boolean };
  reputation: {
    /** indexer-declared average, 0..RANK_SCORE_MAX (null when unrated) */
    declaredAverage: number | null;
    /** on-chain re-derived average when a chain read returned, interpreted with verificationStatus */
    onchainAverage: number | null;
    /** on-chain non-revoked count from get_summary, when available */
    onchainFeedbackCount: number | null;
    declaredFeedbackCount: number;
    /** Indexer-declared only; the contract's append-only client list cannot verify this. */
    declaredUniqueClients: number;
  };
  /** 3-axis ranking breakdown (present only when the profile carries a rank). */
  rank: {
    provenance: "derived-from-indexed-signals";
    score100: number;
    confidence: number;
    quality: number | null;
    volume: number | null;
    breadth: number | null;
  } | null;
}

/** An explicitly unverified A2A-shaped projection, not a conformant AgentCard. */
export interface AgentCard {
  conformance: AgentCardConformance;
  provenance: AgentCardProvenance;
  /** Shape target only; this does not assert protocol conformance. */
  protocolVersion: string;
  /** Server-derived neutral label; owner-authored name is under selfDeclared. */
  name: string;
  /** Server-authored warning; owner-authored description is under selfDeclared. */
  description: string;
  /** Always null until an agent-published A2A endpoint is fetched and verified. */
  url: null;
  preferredTransport: string | null;
  provider: AgentCardProvider;
  /** Placeholder only; self-declared service versions remain under selfDeclared. */
  version: string;
  capabilities: AgentCardCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  /** Always empty: registry services are candidates, not verified A2A skills. */
  skills: AgentCardSkill[];
  selfDeclared: AgentCardSelfDeclared;
  /** Typed identity + explicitly scoped reputation information. */
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
/** Explicit placeholder; registry service versions are not an A2A card version. */
const UNKNOWN_VERSION = "0.0.0";
const PROVENANCE: AgentCardProvenance = Object.freeze({
  source: "stellar8004-indexed-registration",
  a2aDocumentFetched: false,
  a2aProtocolConformanceVerified: false,
  endpointOwnershipVerified: false,
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Project an {@link AgentProfile} to an explicitly unverified A2A-shaped object.
 *
 * Pure function: no I/O, deterministic for a given profile. No endpoint is
 * fetched or probed. Untrusted metadata is copied only into `selfDeclared`.
 */
export function toAgentCard(profile: AgentProfile, options: AgentCardOptions = {}): AgentCard {
  // These optional values are caller-supplied projection hints, never inferred
  // from agent metadata. Defaults stay null/empty to avoid capability claims.
  const inputModes = options.defaultInputModes ? [...options.defaultInputModes] : [];
  const outputModes = options.defaultOutputModes ? [...options.defaultOutputModes] : [];
  const transport = options.preferredTransport ?? null;

  const services = profile.selfDeclared.services.map((service) => ({ ...service }));

  const rank = profile.rank
    ? {
        provenance: "derived-from-indexed-signals" as const,
        score100: profile.rank.score100,
        confidence: profile.rank.confidence,
        quality: profile.rank.quality.raw,
        volume: profile.rank.volume.raw,
        breadth: profile.rank.breadth.raw,
      }
    : null;

  return {
    conformance: "unverified-derived",
    provenance: PROVENANCE,
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: `Stellar 8004 Agent #${profile.id}`,
    description:
      "Unverified projection from indexed Stellar 8004 registration metadata; fetch and validate an " +
      "agent-published A2A card before invocation.",
    url: null,
    preferredTransport: transport,
    provider: {
      organization: profile.owner,
      url: null,
    },
    version: UNKNOWN_VERSION,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [],
    },
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    skills: [],
    selfDeclared: {
      source: "agent-owner-authored-indexed-metadata",
      verified: false,
      name: profile.selfDeclared.name,
      description: profile.selfDeclared.description,
      image: profile.selfDeclared.image,
      agentUri: profile.agentUri,
      wallet: profile.wallet,
      services,
      metadata: { ...profile.selfDeclared.metadata },
      capabilities: {
        x402: profile.capabilities.x402,
        mpp: profile.capabilities.mpp,
      },
      supportedTrust: [...profile.supportedTrust],
    },
    "x-stellar8004": {
      conformance: "unverified-derived",
      provenance: PROVENANCE,
      stellarId: profile.stellarId,
      caip2Id: profile.caip2Id,
      agentId: profile.id,
      network: profile.network,
      owner: profile.owner,
      wallet: null,
      agentUri: null,
      verified: profile.verified,
      verificationStatus: profile.verification.status,
      verificationScope: "reputation-summary-only",
      supportedTrust: [],
      capabilities: {
        x402: false,
        mpp: false,
      },
      reputation: {
        declaredAverage: profile.scores.average,
        onchainAverage: profile.verification.verified?.average ?? null,
        onchainFeedbackCount: profile.verification.verified?.count ?? null,
        declaredFeedbackCount: profile.scores.feedbackCount,
        declaredUniqueClients: profile.scores.uniqueClients,
      },
      rank,
    },
  };
}
