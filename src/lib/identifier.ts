/**
 * identifier.ts — resolve an agent reference to a numeric id and build the
 * canonical stellar identifier strings.
 *
 * Accepted references (research/A §6.1):
 *   - numeric id                 42            → { kind: "id" }
 *   - numeric string             "42"          → { kind: "id" }
 *   - full stellar identifier    stellar:{net}:{identity}#{id}
 *   - owner / wallet G-address   G...          → { kind: "owner" } (needs lookup)
 *
 * Two network-label systems (research/A §6.1):
 *   - identity layer uses  mainnet | testnet
 *   - x402/MPP layer uses  CAIP-2  pubnet | testnet
 * We normalize pubnet <-> mainnet so a handle from either layer resolves.
 */

import type { Network } from "../types.js";

/** Stellar Ed25519 public account address (G...). 56 chars base32. */
export const G_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
/** Soroban contract address (C...). 56 chars base32. */
export const C_ADDRESS_RE = /^C[A-Z2-7]{55}$/;
/** stellar:{network}:{identity}#{id}. Network accepts mainnet|testnet|pubnet. */
export const STELLAR_ID_RE = /^stellar:(mainnet|testnet|pubnet):(C[A-Z2-7]{55})#(\d+)$/;

export type ResolvedRef =
  | { kind: "id"; id: number }
  | { kind: "stellarId"; id: number; identity: string; network: Network }
  | { kind: "owner"; address: string };

/** Identity network label -> CAIP-2 label. */
export function caip2Network(network: Network): "pubnet" | "testnet" {
  return network === "mainnet" ? "pubnet" : "testnet";
}

/** CAIP-2 (or identity) label -> identity network label. */
export function fromNetworkLabel(label: string): Network {
  const l = label.trim().toLowerCase();
  if (l === "mainnet" || l === "pubnet") return "mainnet";
  if (l === "testnet") return "testnet";
  throw new Error(`Unknown network label '${label}' (expected mainnet|testnet|pubnet)`);
}

/** Canonical identity-layer identifier: stellar:{network}:{identity}#{id}. */
export function buildStellarId(network: Network, identity: string, id: number): string {
  return `stellar:${network}:${identity}#${id}`;
}

/** CAIP-2 (x402/MPP-layer) identifier: stellar:{pubnet|testnet}:{identity}#{id}. */
export function buildCaip2Id(network: Network, identity: string, id: number): string {
  return `stellar:${caip2Network(network)}:${identity}#${id}`;
}

function parseId(raw: string): number {
  // Digit-only guard first: Number("0x1f")/Number("1e3")/Number("") would all
  // coerce to a plausible-looking integer otherwise. isSafeInteger rejects
  // oversized ids (>2^53) that lose precision.
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`Invalid agent id '${raw}' (expected a non-negative integer)`);
  }
  return Number(raw);
}

/**
 * Return a wallet string ONLY if it is a valid Stellar G- or C-address, else
 * null. The on-chain `wallet` field is owner-authored and unvalidated by the
 * indexer, so it is untrusted: never emit it as a "typed/verified" value, an
 * A2A card field documented "safe to interpolate", or an x402 payTo unless it
 * actually parses as an address. (Callers previously passed it through raw.)
 */
export function validWalletOrNull(wallet: unknown): string | null {
  if (typeof wallet !== "string") return null;
  const w = wallet.trim();
  return G_ADDRESS_RE.test(w) || C_ADDRESS_RE.test(w) ? w : null;
}

/**
 * Parse any agent reference into a discriminated result. Does NOT perform
 * network I/O — an owner address resolves to a numeric id only via an explorer
 * lookup (getAgentsByAddress), which belongs to the data layer.
 */
export function parseAgentRef(ref: string | number): ResolvedRef {
  if (typeof ref === "number") {
    return { kind: "id", id: parseId(String(ref)) };
  }
  const s = ref.trim();
  if (s === "") throw new Error("Empty agent reference");

  if (/^\d+$/.test(s)) return { kind: "id", id: parseId(s) };

  const m = STELLAR_ID_RE.exec(s);
  if (m) {
    return {
      kind: "stellarId",
      id: parseId(m[3]!),
      identity: m[2]!,
      network: fromNetworkLabel(m[1]!),
    };
  }

  if (G_ADDRESS_RE.test(s)) return { kind: "owner", address: s };

  throw new Error(
    `Unrecognized agent reference: '${s}'. Expected a numeric id, a ` +
      `stellar:{network}:{identity}#{id} handle, or an owner G-address.`,
  );
}

/**
 * Resolve a reference to a numeric id when it is directly known (id or full
 * stellar identifier). Returns null for an owner address, which requires an
 * explorer lookup to resolve.
 */
export function resolveAgentId(ref: string | number): number | null {
  const parsed = parseAgentRef(ref);
  return parsed.kind === "owner" ? null : parsed.id;
}
