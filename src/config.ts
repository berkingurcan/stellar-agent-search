/**
 * config.ts — env → typed Config.
 *
 * Network defaults to mainnet (SOW requirement). Contract addresses, RPC URL
 * and passphrase are REUSED from @trionlabs/stellar8004's getConfig()/
 * MAINNET_CONFIG — never re-derived here.
 *
 * One data source per launch:
 *   - EXPLORER_BASE_URL: an indexer (mainnet defaults to stellar8004.com).
 *   - REGISTRY_AGENT_IDS: registry mode over an operator allowlist.
 *   - REGISTRY_SCAN_LIMIT: registry mode over the newest agents the Identity
 *     contract registered. Testnet uses it by default (limit 50) when neither
 *     other source is set, because the default explorer indexes mainnet only.
 *
 * Defense in depth: this server is READ-ONLY and keyless. STELLAR_PRIVATE_KEY
 * is intentionally ignored (and warned about) if present.
 */

import { getConfig } from "@trionlabs/stellar8004";
import type { Network, StellarConfig } from "./types.js";
import { MAX_AGENT_ID, validWalletOrNull } from "./lib/identifier.js";
import { log } from "./lib/logger.js";

/** Local display normalization policy; the protocol itself allows signed i128 + decimals. */
export const RANK_SCORE_MAX = 100;

/** Default explorer HTTP API base. */
export const DEFAULT_EXPLORER_BASE = "https://stellar8004.com";

/**
 * Most agents registry mode reads. Each one costs three contract simulations and
 * possibly a registration-file fetch, and every list or search reads them all.
 */
export const MAX_REGISTRY_AGENT_IDS = 50;

/** Most of the newest agents the registry scan reads (REGISTRY_SCAN_LIMIT), for the same reason. */
export const MAX_REGISTRY_SCAN_LIMIT = MAX_REGISTRY_AGENT_IDS;

/** How many of the newest agents testnet reads when no data source is set. */
export const DEFAULT_REGISTRY_SCAN_LIMIT = MAX_REGISTRY_SCAN_LIMIT;

/** Most validators TRUSTED_VALIDATORS may list; each is one argument to a contract read. */
export const MAX_TRUSTED_VALIDATORS = 20;

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
  /** Explorer HTTP API base (env override or default); null in registry mode. */
  explorerBaseUrl: string | null;
  /**
   * Registry mode over an allowlist: the agents read straight from the Identity
   * contract (REGISTRY_AGENT_IDS). Null otherwise.
   */
  registryAgentIds: readonly number[] | null;
  /**
   * Registry mode over the newest agents: how many of the most recently
   * registered agents lists and searches read straight from the Identity contract
   * (REGISTRY_SCAN_LIMIT; testnet's default). Null otherwise.
   */
  registryScanLimit: number | null;
  /**
   * Validation Registry validators whose Provider Standard records earn badges
   * (TRUSTED_VALIDATORS). Empty: the registry is not read.
   */
  trustedValidators: readonly string[];
  /** Whether to attempt the bounded Reputation-contract probe. */
  verifyOnchain: boolean;
  /** Feedback score scale (RANK_SCORE_MAX). */
  scoreMax: number;
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

/** REGISTRY_AGENT_IDS: comma- or space-separated agent ids. Blank counts as absent. */
export function parseRegistryAgentIds(raw: string | undefined): number[] | null {
  const text = raw?.trim();
  if (!text) return null;
  const ids = new Set<number>();
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    if (!/^\d+$/.test(token) || Number(token) > MAX_AGENT_ID) {
      throw new ConfigError(
        `REGISTRY_AGENT_IDS must be a comma-separated list of agent ids (0..${MAX_AGENT_ID}), got '${token}'`,
      );
    }
    ids.add(Number(token));
  }
  if (ids.size > MAX_REGISTRY_AGENT_IDS) {
    throw new ConfigError(
      `REGISTRY_AGENT_IDS lists ${ids.size} agents; registry mode reads at most ${MAX_REGISTRY_AGENT_IDS}.`,
    );
  }
  return [...ids];
}

/** REGISTRY_SCAN_LIMIT: how many of the newest agents to read, 1..50. Blank counts as absent. */
export function parseRegistryScanLimit(raw: string | undefined): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const limit = Number(text);
  if (!/^\d+$/.test(text) || limit < 1 || limit > MAX_REGISTRY_SCAN_LIMIT) {
    throw new ConfigError(
      `REGISTRY_SCAN_LIMIT must be a whole number of agents from 1 to ${MAX_REGISTRY_SCAN_LIMIT}, got '${raw}'`,
    );
  }
  return limit;
}

/** True when the agents come straight from the Identity contract (an allowlist or the newest-agents scan). */
export function isRegistryMode(config: Pick<Config, "registryAgentIds" | "registryScanLimit">): boolean {
  return config.registryAgentIds !== null || config.registryScanLimit !== null;
}

/**
 * TRUSTED_VALIDATORS: comma- or space-separated G… or C… addresses with a valid
 * checksum. Blank counts as absent (an empty list).
 */
export function parseTrustedValidators(raw: string | undefined): string[] {
  const text = raw?.trim();
  if (!text) return [];
  const validators = new Set<string>();
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    if (validWalletOrNull(token) !== token) {
      throw new ConfigError(
        `TRUSTED_VALIDATORS must be a comma-separated list of Stellar G… or C… addresses, got '${token}'`,
      );
    }
    validators.add(token);
  }
  if (validators.size > MAX_TRUSTED_VALIDATORS) {
    throw new ConfigError(
      `TRUSTED_VALIDATORS lists ${validators.size} validators; at most ${MAX_TRUSTED_VALIDATORS} are read.`,
    );
  }
  return [...validators];
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
  const registryAgentIds = parseRegistryAgentIds(env.REGISTRY_AGENT_IDS);
  const scanLimitSetting = parseRegistryScanLimit(env.REGISTRY_SCAN_LIMIT);
  // Two sources would answer the same question differently (the indexer
  // enumerates the registry; registry mode reads an allowlist or the newest
  // agents), and nothing here could say which one a given row came from.
  if (explorerOverride && registryAgentIds) {
    throw new ConfigError(
      `Set EXPLORER_BASE_URL or REGISTRY_AGENT_IDS, not both. EXPLORER_BASE_URL reads an indexer; ` +
        `REGISTRY_AGENT_IDS reads those agents straight from the Identity contract (registry mode).`,
    );
  }
  if (scanLimitSetting !== null && (explorerOverride || registryAgentIds)) {
    throw new ConfigError(
      `Set REGISTRY_SCAN_LIMIT or ${explorerOverride ? "EXPLORER_BASE_URL" : "REGISTRY_AGENT_IDS"}, not both. ` +
        `REGISTRY_SCAN_LIMIT reads the newest agents straight from the Identity contract (registry mode); ` +
        (explorerOverride
          ? "EXPLORER_BASE_URL reads an indexer."
          : "REGISTRY_AGENT_IDS reads only the agents it names."),
    );
  }
  // The default explorer indexes MAINNET only (its own responses report
  // network=mainnet), while STELLAR_NETWORK also selects the Soroban contracts
  // and RPC. Testnet therefore never falls back to it: with no source set, it
  // reads the newest agents straight from the testnet Identity contract, so the
  // rows and the on-chain reads describe one chain. The scan is bounded, and its
  // coverage says how many agents it read and how many exist.
  const registryScanLimit =
    scanLimitSetting ??
    (network === "testnet" && !explorerOverride && !registryAgentIds ? DEFAULT_REGISTRY_SCAN_LIMIT : null);
  const explorerBaseUrl =
    registryAgentIds || registryScanLimit !== null ? null : explorerOverride || DEFAULT_EXPLORER_BASE;

  const legacyRankingWeight = ["RANK_W_QUALITY", "RANK_W_VOLUME", "RANK_W_BREADTH"].find(
    (name) => env[name]?.trim(),
  );
  if (legacyRankingWeight) {
    throw new ConfigError(
      `${legacyRankingWeight} is no longer supported. Ranking policy ` +
        `stellar-agent-search-declared-evidence-v1 uses fixed evidence weights ` +
        `(volume=0.4, breadth=0.6) so callers cannot silently redefine score semantics.`,
    );
  }
  const rawScoreMax = env.RANK_SCORE_MAX?.trim();
  if (rawScoreMax) {
    const configuredScoreMax = Number(rawScoreMax);
    if (!Number.isFinite(configuredScoreMax) || configuredScoreMax !== RANK_SCORE_MAX) {
      throw new ConfigError(
        `RANK_SCORE_MAX cannot change stellar-agent-search-declared-evidence-v1 semantics; ` +
          `the only accepted value is ${RANK_SCORE_MAX}, got '${env.RANK_SCORE_MAX}'.`,
      );
    }
  }
  // Keep the field for runtime drift assertions and response plumbing, but do
  // not let an environment variable silently redefine a versioned policy.
  const scoreMax = RANK_SCORE_MAX;

  return {
    network,
    stellar,
    rpcUrl: env.STELLAR_RPC_URL?.trim() || stellar.rpcUrl,
    explorerBaseUrl,
    registryAgentIds,
    registryScanLimit,
    trustedValidators: parseTrustedValidators(env.TRUSTED_VALIDATORS),
    verifyOnchain: parseBool(env.VERIFY_ONCHAIN, true, "VERIFY_ONCHAIN"),
    scoreMax,
    ...(env.RANK_SIM_SOURCE?.trim() ? { simSource: env.RANK_SIM_SOURCE.trim() } : {}),
  };
}
