/**
 * config.ts — env → typed Config.
 *
 * Network defaults to mainnet (SOW requirement). Contract addresses, RPC URL
 * and passphrase are REUSED from @trionlabs/stellar8004's getConfig()/
 * MAINNET_CONFIG — never re-derived here.
 *
 * Defense in depth: this server is READ-ONLY and keyless. STELLAR_PRIVATE_KEY
 * is intentionally ignored (and warned about) if present.
 */

import { getConfig } from "@trionlabs/stellar8004";
import type { Network, RankWeights, StellarConfig } from "./types.js";
import { log } from "./lib/logger.js";

/** Feedback values are 0..100 integers (valueDecimals=0). */
export const RANK_SCORE_MAX = 100;

/** Default 3-axis weights (breadth > volume for sybil-resistance). */
export const DEFAULT_WEIGHTS: RankWeights = { quality: 0.5, volume: 0.2, breadth: 0.3 };

/** Default explorer HTTP API base. */
export const DEFAULT_EXPLORER_BASE = "https://stellar8004.com";

export interface Config {
  network: Network;
  /** Full SDK config: contracts.{identity,reputation,validation}, passphrase, rpcUrl. */
  stellar: StellarConfig;
  /** Effective Soroban RPC URL (env override or stellar.rpcUrl). */
  rpcUrl: string;
  /** Explorer HTTP API base (env override or default). */
  explorerBaseUrl: string;
  /** Whether to perform on-chain reputation verification. */
  verifyOnchain: boolean;
  /** Feedback score scale (RANK_SCORE_MAX). */
  scoreMax: number;
  /** 3-axis ranking weights (env-overridable). */
  weights: RankWeights;
}

function parseNetwork(raw: string | undefined): Network {
  const n = (raw ?? "mainnet").trim().toLowerCase();
  if (n === "mainnet" || n === "testnet") return n;
  throw new Error(`STELLAR_NETWORK must be 'mainnet' or 'testnet', got '${raw}'`);
}

function parseBool(raw: string | undefined, def: boolean): boolean {
  if (raw == null) return def;
  const s = raw.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return def;
}

function parseNum(raw: string | undefined, def: number): number {
  if (raw == null || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

/**
 * Load config from an environment map (defaults to process.env).
 * Throws on an invalid STELLAR_NETWORK so a bad launch fails fast.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.STELLAR_PRIVATE_KEY) {
    // Read-only server: a secret must never be used. Do not read it.
    log.warn("STELLAR_PRIVATE_KEY is set but ignored — this server is read-only and keyless");
  }

  const network = parseNetwork(env.STELLAR_NETWORK);
  const stellar = getConfig(network); // mainnet ⇒ MAINNET_CONFIG

  const explorerBaseUrl = env.EXPLORER_BASE_URL?.trim() || DEFAULT_EXPLORER_BASE;
  if (network === "testnet" && explorerBaseUrl === DEFAULT_EXPLORER_BASE) {
    // The default explorer indexes MAINNET only (its own responses report
    // network=mainnet). Soroban reads would follow the testnet contracts while
    // the registry rows came from mainnet, so discovery and verification would
    // silently describe two different chains. Warn rather than fake agreement —
    // same contract as verification degrading to `unavailable`.
    log.warn(
      `STELLAR_NETWORK=testnet but EXPLORER_BASE_URL is the mainnet default (${DEFAULT_EXPLORER_BASE}) — ` +
        "registry data will be MAINNET while on-chain reads use testnet. " +
        "Set EXPLORER_BASE_URL to a testnet indexer, or use mainnet.",
    );
  }

  const weights: RankWeights = {
    quality: parseNum(env.RANK_W_QUALITY, DEFAULT_WEIGHTS.quality),
    volume: parseNum(env.RANK_W_VOLUME, DEFAULT_WEIGHTS.volume),
    breadth: parseNum(env.RANK_W_BREADTH, DEFAULT_WEIGHTS.breadth),
  };

  return {
    network,
    stellar,
    rpcUrl: env.STELLAR_RPC_URL?.trim() || stellar.rpcUrl,
    explorerBaseUrl,
    verifyOnchain: parseBool(env.VERIFY_ONCHAIN, true),
    scoreMax: parseNum(env.RANK_SCORE_MAX, RANK_SCORE_MAX),
    weights,
  };
}
