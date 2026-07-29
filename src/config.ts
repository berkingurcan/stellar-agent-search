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

/** Default 3-axis weights (breadth > volume as a Sybil-cost hedge, not resistance). */
export const DEFAULT_WEIGHTS: RankWeights = { quality: 0.5, volume: 0.2, breadth: 0.3 };

/** Default explorer HTTP API base. */
export const DEFAULT_EXPLORER_BASE = "https://stellar8004.com";

/**
 * A launch refused because the environment is misconfigured — not a bug, and not
 * something a stack trace helps with. The entry point prints these as a plain
 * `error:` line and exits 2, the same shape as a bad CLI flag.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

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
  /** Optional funded simulation source; omitted for the default fabricated read-only source. */
  simSource?: string;
}

/** Runtime-neutral environment map (Node process.env or a Worker binding object). */
export type EnvironmentMap = Readonly<Record<string, string | undefined>>;

function defaultEnvironment(): EnvironmentMap {
  return typeof process !== "undefined" ? process.env : {};
}

function parseNetwork(raw: string | undefined): Network {
  const n = (raw ?? "mainnet").trim().toLowerCase();
  if (n === "mainnet" || n === "testnet") return n;
  throw new ConfigError(`STELLAR_NETWORK must be 'mainnet' or 'testnet', got '${raw}'`);
}

function parseBool(raw: string | undefined, def: boolean, name: string): boolean {
  if (raw == null) return def;
  const s = raw.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  throw new ConfigError(`${name} must be a boolean (true/false, 1/0, yes/no, on/off), got '${raw}'`);
}

function parseNum(raw: string | undefined, def: number, name: string): number {
  if (raw == null || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${name} must be a finite number, got '${raw}'`);
  return n;
}

/**
 * Load config from an environment map (defaults to process.env in Node and an
 * empty map in runtimes without `process`). Worker entrypoints must pass their
 * string bindings explicitly.
 * Throws on an invalid STELLAR_NETWORK so a bad launch fails fast.
 */
export function loadConfig(env: EnvironmentMap = defaultEnvironment()): Config {
  if (env.STELLAR_PRIVATE_KEY) {
    // Read-only server: a secret must never be used. Do not read it.
    log.warn("STELLAR_PRIVATE_KEY is set but ignored — this server is read-only and keyless");
  }

  const network = parseNetwork(env.STELLAR_NETWORK);
  const stellar = getConfig(network); // mainnet ⇒ MAINNET_CONFIG

  const explorerOverride = env.EXPLORER_BASE_URL?.trim();
  if (network === "testnet" && !explorerOverride) {
    // The default explorer indexes MAINNET only (its own responses report
    // network=mainnet). Soroban reads follow the testnet contracts while the
    // registry rows come from mainnet, so discovery and verification would
    // describe two different chains as one. There is no testnet indexer to
    // fall back to, so refuse the launch instead of serving the mix — degrade
    // closed, never fake, applied to startup rather than to a single read.
    throw new ConfigError(
      `STELLAR_NETWORK=testnet requires an explicit EXPLORER_BASE_URL. The default explorer ` +
        `(${DEFAULT_EXPLORER_BASE}) indexes mainnet only, so testnet would serve MAINNET registry rows ` +
        `alongside testnet on-chain reads — two chains described as one. ` +
        `Point EXPLORER_BASE_URL at a testnet indexer, or use STELLAR_NETWORK=mainnet.`,
    );
  }
  const explorerBaseUrl = explorerOverride || DEFAULT_EXPLORER_BASE;

  const weights: RankWeights = {
    quality: parseNum(env.RANK_W_QUALITY, DEFAULT_WEIGHTS.quality, "RANK_W_QUALITY"),
    volume: parseNum(env.RANK_W_VOLUME, DEFAULT_WEIGHTS.volume, "RANK_W_VOLUME"),
    breadth: parseNum(env.RANK_W_BREADTH, DEFAULT_WEIGHTS.breadth, "RANK_W_BREADTH"),
  };
  if (Object.values(weights).some((value) => value < 0) || Object.values(weights).every((value) => value === 0)) {
    throw new ConfigError("Ranking weights must be non-negative and at least one must be greater than zero");
  }
  const scoreMax = parseNum(env.RANK_SCORE_MAX, RANK_SCORE_MAX, "RANK_SCORE_MAX");
  if (scoreMax <= 0) throw new ConfigError("RANK_SCORE_MAX must be greater than zero");

  return {
    network,
    stellar,
    rpcUrl: env.STELLAR_RPC_URL?.trim() || stellar.rpcUrl,
    explorerBaseUrl,
    verifyOnchain: parseBool(env.VERIFY_ONCHAIN, true, "VERIFY_ONCHAIN"),
    scoreMax,
    weights,
    ...(env.RANK_SIM_SOURCE?.trim() ? { simSource: env.RANK_SIM_SOURCE.trim() } : {}),
  };
}
