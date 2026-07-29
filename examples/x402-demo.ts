/**
 * examples/x402-demo.ts — the reference "agent-finds-agent" loop (SOW Deliverable 2).
 *
 * One autonomous agent, no human in the loop:
 *   [1] PREFLIGHT   — Horizon balances (USDC trustline? USDC >= min? XLM >= min for the
 *                     self-paid feedback tx?), RPC health, payer != scrapper owner.
 *   [2] DISCOVER    — spawn OUR read-only MCP server over stdio (secret-free child env) and call
 *                     find_agent + get_agent_profile to resolve the scrapper's endpoint + capabilities.
 *   [3] PAY (x402)  — manual 402 flow via @x402/fetch + @x402/stellar. The payment is signed HERE and
 *                     submitted as a header; the resource server settles it with whichever facilitator
 *                     it chose, so this client needs no facilitator credential. network, asset, payTo
 *                     and amount all come from the 402 challenge and are all checked. Real mainnet USDC.
 *   [4] RECEIVE     — the scraped result in the 200 body.
 *   [5] FEEDBACK    — write on-chain reputation via @trionlabs/stellar8004 give_feedback. This is the
 *                     second and only other signing site after the x402 authorization above.
 *   [6] EVIDENCE    — append a crash-safe payment/feedback journal, print 2 mainnet tx hashes + Stellar Expert
 *                     links, then write the final run.json acceptance receipt (NO secrets/result body).
 *
 * SECURITY BOUNDARY (non-negotiable): the MCP server is READ-ONLY and holds NO private keys. Every
 * signing operation (the x402 USDC payment AND give_feedback) happens ONLY in THIS process, using
 * STELLAR_PRIVATE_KEY from the environment. The MCP subprocess is spawned with an env allowlist that
 * NEVER contains STELLAR_PRIVATE_KEY or X402_API_KEY. The key is never logged, never written to run.json,
 * never sent over MCP. This file is the only trusted, keyed actor.
 *
 * DRY_RUN=1 → balance/key/RPC preflight checks are advisory; MCP discovery + pinned identity/x402/endpoint
 * checks are fatal. No payment, no feedback, no spend. A degraded discovery can never claim success.
 *
 * This is a SEPARATE process from src/ and is deliberately allowed to import signing libraries.
 */

import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { config as loadDotenv } from "dotenv";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { x402Client, x402HTTPClient, decodePaymentResponseHeader } from "@x402/fetch";
import {
  createEd25519Signer,
  ExactStellarScheme,
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
  STELLAR_WILDCARD_CAIP2,
  USDC_PUBNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
} from "@x402/stellar";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";

import {
  createClients,
  wrapBasicSigner,
  MAINNET_CONFIG,
  TESTNET_CONFIG,
} from "@trionlabs/stellar8004";
import type { StellarConfig } from "@trionlabs/stellar8004";
import {
  Address,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Constants (mainnet — CONTEXT §1 / §7 LIVE-VERIFIED)
// ---------------------------------------------------------------------------

/**
 * The mainnet evidence target is intentionally pinned. A registry/profile or
 * x402 challenge change must be reviewed in source control before this script
 * can sign anything; runtime discovery is not authority to change the payee.
 */
export const SCRAPPER_AGENT_ID = 10;
export const SCRAPPER_OWNER = "GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V";
export const SCRAPPER_EXPECTED_PAY_TO = "GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V";
export const SCRAPPER_ALLOWED_ENDPOINTS = Object.freeze(["https://scrapper.stellar8004.com/task"] as const);

const REPUTATION_CONTRACT_MAINNET = "CBOIAIMMWAXI57OATLX6BWVDQLCC4YU55HV6MZXFRP6CBSGAMXSTEPPA";
/**
 * USDC SAC address, taken from @x402/stellar rather than re-typed. Unlike `src/`,
 * which stays keyless and therefore hardcodes it (pinned by
 * test/onchain-constants.test.ts), this process already imports the signing SDK.
 */
const USDC_CONTRACT_MAINNET = USDC_PUBNET_ADDRESS;
const USDC_CONTRACT_TESTNET = USDC_TESTNET_ADDRESS;
/** Circle/SDF-published classic issuers corresponding to the SACs above. */
const USDC_ISSUER_MAINNET = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC_ISSUER_TESTNET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
/** USDC on Stellar is a 7-decimal SAC; challenge `amount` is in those base units. */
const USDC_DECIMALS = 7;
/** Keep signed authorization lifetime narrow enough for a deliberate one-shot call. */
const MAX_CHALLENGE_TIMEOUT_SECONDS = 300;
/** A paid endpoint is still untrusted; never buffer an unlimited response. */
const MAX_PAID_RESULT_BYTES = 1_048_576;
const MAX_SETTLEMENT_HEADER_BYTES = 32_768;
/** Bound receipt headers and every post-payment stage separately. */
const UNPAID_CHALLENGE_TIMEOUT_MS = 15_000;
const SIGNED_SERVICE_TIMEOUT_MS = 60_000;
const PAID_RESULT_TIMEOUT_MS = 30_000;
const SETTLEMENT_RPC_TIMEOUT_MS = 20_000;
const FEEDBACK_ASSEMBLY_TIMEOUT_MS = 30_000;
const FEEDBACK_SEND_TIMEOUT_MS = 90_000;
const FEEDBACK_RPC_TIMEOUT_MS = 20_000;

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type NetworkLabel = "mainnet" | "testnet";
type Caip2 = typeof STELLAR_PUBNET_CAIP2 | typeof STELLAR_TESTNET_CAIP2;

export interface DemoConfig {
  /** Identity-layer label passed to the server and used for evidence/config selection. */
  network: NetworkLabel;
  /** CAIP-2 label used by the x402 layer (pubnet for mainnet). */
  caip2: Caip2;
  rpcUrl: string;
  horizonUrl: string;
  explorerBaseUrl: string | null;
  /** Absolute path to the built MCP server entry the demo spawns (read-only, keyless). */
  mcpServerEntry: string;
  /** @trionlabs SDK config for the reputation write. */
  stellar: StellarConfig;
  minUsdc: number;
  minXlm: number;
  /** Hard ceiling, in USDC, on what a single 402 challenge may ask for. */
  maxPriceUsdc: number;
  dryRun: boolean;
  /** Present only when STELLAR_PRIVATE_KEY is set (required for a real run). */
  payerPublicKey: string | null;
  /** HTTP method + JSON body used to invoke the scrapper task endpoint. */
  scrapeMethod: string;
  scrapeBody: string | null;
}

/**
 * Convert an arbitrary failure into an operator-safe message. RPC/client
 * libraries may include the request URL in their own errors, and provider URLs
 * commonly carry API keys in a path or query string.
 */
export function redactSensitiveError(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let message = error instanceof Error ? error.message : String(error);
  const sensitiveValues = [env.STELLAR_PRIVATE_KEY, env.X402_API_KEY, env.STELLAR_RPC_URL]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  const rpcUrl = env.STELLAR_RPC_URL?.trim();
  if (rpcUrl) {
    try {
      const parsed = new URL(rpcUrl);
      if (parsed.username) sensitiveValues.push(parsed.username);
      if (parsed.password) sensitiveValues.push(parsed.password);
      for (const value of parsed.searchParams.values()) {
        if (value) sensitiveValues.push(value);
      }
      for (const segment of parsed.pathname.split("/")) {
        // Provider keys are commonly embedded as long opaque path segments.
        // Avoid replacing harmless route fragments such as `v1`.
        if (segment.length >= 6) sensitiveValues.push(segment);
      }
    } catch {
      // loadConfig owns URL validation. Redaction remains best-effort while
      // reporting that validation failure itself.
    }
  }

  const variants = new Set<string>();
  for (const value of sensitiveValues) {
    variants.add(value);
    variants.add(encodeURIComponent(value));
    try {
      variants.add(decodeURIComponent(value));
    } catch {
      // A malformed percent escape is still covered by the literal variant.
    }
  }
  for (const value of [...variants].filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(value).join("[REDACTED]");
  }
  return message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 4_000);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const raw = (env.STELLAR_NETWORK ?? "mainnet").toLowerCase();
  if (raw !== "mainnet" && raw !== "testnet") {
    throw new Error(`STELLAR_NETWORK must be 'mainnet' or 'testnet', got '${raw}'`);
  }
  const network = raw as NetworkLabel;
  const isMain = network === "mainnet";
  const dryRun = env.DRY_RUN === "1" || env.DRY_RUN?.toLowerCase() === "true";

  // Derive the payer public key from the S-key WITHOUT keeping the secret around.
  let payerPublicKey: string | null = null;
  const secret = env.STELLAR_PRIVATE_KEY?.trim();
  if (secret) {
    try {
      payerPublicKey = Keypair.fromSecret(secret).publicKey();
    } catch {
      throw new Error("STELLAR_PRIVATE_KEY is not a valid S-format Stellar secret key");
    }
  }

  const entryRaw = env.MCP_SERVER_ENTRY ?? "../dist/index.js";
  const mcpServerEntry = isAbsolute(entryRaw) ? entryRaw : resolve(HERE, entryRaw);

  const rpcUrl =
    env.STELLAR_RPC_URL?.trim() ||
    (isMain ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org");
  const parsedRpc = new URL(rpcUrl);
  if (parsedRpc.username || parsedRpc.password || parsedRpc.hash) {
    throw new Error("STELLAR_RPC_URL must not contain URL credentials or a fragment");
  }
  if (!dryRun && parsedRpc.protocol !== "https:") {
    throw new Error("a funded run requires an HTTPS STELLAR_RPC_URL");
  }

  return {
    network,
    caip2: isMain ? STELLAR_PUBNET_CAIP2 : STELLAR_TESTNET_CAIP2,
    rpcUrl,
    horizonUrl: isMain ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org",
    explorerBaseUrl: env.EXPLORER_BASE_URL?.trim() || null,
    mcpServerEntry,
    stellar: isMain ? MAINNET_CONFIG : TESTNET_CONFIG,
    minUsdc: numEnv(env.MIN_USDC, 0.1, "MIN_USDC"),
    minXlm: numEnv(env.MIN_XLM, 3, "MIN_XLM"),
    maxPriceUsdc: numEnv(env.MAX_PRICE_USDC, 0.1, "MAX_PRICE_USDC"),
    dryRun,
    payerPublicKey,
    scrapeMethod: (env.SCRAPE_METHOD ?? "POST").toUpperCase(),
    scrapeBody: env.SCRAPE_BODY ?? JSON.stringify({ url: env.SCRAPE_TARGET ?? "https://example.com" }),
  };
}

function numEnv(v: string | undefined, dflt: number, name: string): number {
  if (v == null || v.trim() === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a finite non-negative number, got '${v}'`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// [1] Preflight
// ---------------------------------------------------------------------------

interface HorizonBalance {
  balance: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

async function horizonBalances(cfg: DemoConfig, account: string): Promise<HorizonBalance[]> {
  const res = await fetch(`${cfg.horizonUrl}/accounts/${account}`);
  if (res.status === 404) throw new Error(`account ${account} does not exist on ${cfg.network}`);
  if (!res.ok) throw new Error(`Horizon ${res.status} for account ${account}`);
  const body = (await res.json()) as { balances?: HorizonBalance[] };
  return body.balances ?? [];
}

async function rpcHealthy(cfg: DemoConfig): Promise<boolean> {
  const res = await fetch(cfg.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { result?: { status?: string } };
  return body.result?.status === "healthy";
}

/**
 * Runs the preflight checks. In a real run any failure aborts before money moves.
 * In DRY_RUN checks are advisory (logged WARN, never fatal) so the loop can still
 * demonstrate discovery without funded accounts.
 */
async function runPreflight(cfg: DemoConfig): Promise<void> {
  const advisory = cfg.dryRun;
  const checks: Array<[string, () => Promise<void>]> = [
    // NOTE: there is deliberately no facilitator-credential check here. This client
    // never contacts a facilitator: it signs the payment locally and submits it as a
    // header, and the *resource server* verifies and settles with whichever
    // facilitator it chose. Verified against the live challenge from
    // scrapper.stellar8004.com, which names no facilitator at all. An earlier
    // revision made X402_API_KEY a fatal mainnet precondition, which would have
    // aborted a funded run over a credential nothing in this file reads.
    [
      "RPC reachable + healthy",
      async () => {
        // The configured RPC URL may carry a provider API key in its path or
        // query string. Never echo it into CI/operator logs on a health failure.
        if (!(await rpcHealthy(cfg))) throw new Error("configured Stellar RPC endpoint is not healthy");
      },
    ],
    [
      "payer key present",
      async () => {
        if (!cfg.payerPublicKey) throw new Error("STELLAR_PRIVATE_KEY not set");
      },
    ],
    [
      "account exists + USDC trustline present",
      async () => {
        if (!cfg.payerPublicKey) throw new Error("skipped (no payer key)");
        const bals = await horizonBalances(cfg, cfg.payerPublicKey);
        const issuer = cfg.network === "mainnet" ? USDC_ISSUER_MAINNET : USDC_ISSUER_TESTNET;
        const usdc = bals.find(
          (b) =>
            b.asset_type !== "native" && b.asset_code === "USDC" && b.asset_issuer === issuer,
        );
        if (!usdc) throw new Error("USDC trustline missing — transfers FAIL SILENTLY; add trustline first");
      },
    ],
    [
      "USDC balance sufficient",
      async () => {
        if (!cfg.payerPublicKey) throw new Error("skipped (no payer key)");
        const bals = await horizonBalances(cfg, cfg.payerPublicKey);
        const issuer = cfg.network === "mainnet" ? USDC_ISSUER_MAINNET : USDC_ISSUER_TESTNET;
        const usdc = Number(
          bals.find(
            (b) =>
              b.asset_type !== "native" && b.asset_code === "USDC" && b.asset_issuer === issuer,
          )?.balance ?? 0,
        );
        if (usdc < cfg.minUsdc) throw new Error(`USDC ${usdc} < required ${cfg.minUsdc}`);
      },
    ],
    [
      "XLM sufficient (reserves + self-paid give_feedback fee)",
      async () => {
        if (!cfg.payerPublicKey) throw new Error("skipped (no payer key)");
        const bals = await horizonBalances(cfg, cfg.payerPublicKey);
        const xlm = Number(bals.find((b) => b.asset_type === "native")?.balance ?? 0);
        if (xlm < cfg.minXlm) throw new Error(`XLM ${xlm} < required ${cfg.minXlm}`);
      },
    ],
    [
      "payer != scrapper owner (SelfFeedback guard)",
      async () => {
        if (cfg.payerPublicKey && cfg.payerPublicKey === SCRAPPER_OWNER) {
          throw new Error("payer == scrapper owner → give_feedback would revert SelfFeedback; use a different key");
        }
      },
    ],
  ];

  for (const [label, fn] of checks) {
    process.stderr.write(`[preflight] ${label} ... `);
    try {
      await fn();
      process.stderr.write("OK\n");
    } catch (err) {
      const msg = redactSensitiveError(err);
      if (advisory) {
        process.stderr.write(`WARN (${msg})\n`);
      } else {
        process.stderr.write("FAIL\n");
        throw new Error(`preflight failed at "${label}": ${msg}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// [2] Discovery via the read-only MCP server (spawned with a secret-free env)
// ---------------------------------------------------------------------------

export interface ResolvedAgent {
  agentId: number;
  name: string | null;
  endpoint: string;
  /** Cross-check only; the challenge payTo must also match the source-pinned expected payee. */
  wallet: string | null;
  owner: string | null;
  x402Enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolErrorDetail(res: Record<string, any>): string {
  const content = Array.isArray(res.content) ? res.content : [];
  const text = content
    .filter((part): part is { text: string } => isRecord(part) && typeof part.text === "string")
    .map((part) => part.text)
    .join("; ")
    .trim();
  return text ? `: ${text.slice(0, 500)}` : "";
}

/**
 * MCP tool calls return transport-success even when the tool itself failed.
 * Evidence code must inspect `isError` and require structuredContent instead
 * of treating an empty object as a valid discovery response.
 */
export function requireMcpStructuredContent(tool: string, res: unknown): Record<string, any> {
  if (!isRecord(res)) throw new Error(`${tool}: MCP returned a non-object result`);
  if (res.isError === true) throw new Error(`${tool}: MCP tool failed${toolErrorDetail(res)}`);
  if (!isRecord(res.structuredContent)) {
    throw new Error(`${tool}: MCP result is missing object structuredContent`);
  }
  return res.structuredContent;
}

/** This reference run proves the known Scrapper, so discovery must actually return agent 10. */
export function pickScrapper(agents: unknown): Record<string, any> {
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error("find_agent: structuredContent.agents must be a non-empty array");
  }
  const hit = agents.find((agent) => isRecord(agent) && agent.id === SCRAPPER_AGENT_ID);
  if (!isRecord(hit)) {
    throw new Error(`find_agent: expected Scrapper agent ${SCRAPPER_AGENT_ID} was not discovered; refusing fallback`);
  }
  return hit;
}

/** Resolve the x402 task endpoint from a profile's self-declared services. */
export function resolveEndpoint(profile: Record<string, any>): string {
  const services: any[] = profile?.selfDeclared?.services;
  if (!Array.isArray(services)) {
    throw new Error("get_agent_profile: profile.selfDeclared.services must be an array");
  }
  const https = services.filter((s) => typeof s?.endpoint === "string" && s.endpoint.startsWith("https://"));
  const taskish = https.find((s) => /task|scrap|api/i.test(String(s.endpoint)));
  const endpoint = taskish?.endpoint ?? https[0]?.endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("get_agent_profile: no HTTPS service endpoint was declared; refusing fallback");
  }
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new Error("endpoint must be HTTPS and contain no credentials or fragment");
    }
  } catch (err) {
    throw new Error(
      `get_agent_profile: invalid service endpoint '${endpoint}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return endpoint;
}

function assertPublicKey(label: string, value: string | null): string {
  if (!value) throw new Error(`${label} is missing`);
  try {
    Keypair.fromPublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid Stellar G-address: ${value}`);
  }
  return value;
}

/** Never reclassify a credential-bearing URL as safe merely because its env-key name looks harmless. */
export function credentialFreeChildUrl(label: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL before it can be forwarded to the MCP child`);
  }
  if (
    !/^https?:$/.test(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new Error(`${label} is credential-bearing or non-canonical; refusing to forward it to the MCP child`);
  }
  return value;
}

/** Pin every identity/routing fact before a real evidence run can sign. */
export function assertEvidenceTarget(cfg: DemoConfig, agent: ResolvedAgent): void {
  if (!agent.x402Enabled) throw new Error("discovered Scrapper does not advertise x402 — aborting");
  if (agent.agentId !== SCRAPPER_AGENT_ID) {
    throw new Error(`agent mismatch: discovered=${agent.agentId} expected=${SCRAPPER_AGENT_ID}`);
  }
  if (assertPublicKey("profile.owner", agent.owner) !== SCRAPPER_OWNER) {
    throw new Error(`owner mismatch: profile=${agent.owner} expected=${SCRAPPER_OWNER}`);
  }
  if (!(SCRAPPER_ALLOWED_ENDPOINTS as readonly string[]).includes(agent.endpoint)) {
    throw new Error(
      `endpoint '${agent.endpoint}' is not in the evidence allowlist (${SCRAPPER_ALLOWED_ENDPOINTS.join(", ")})`,
    );
  }
  if (!cfg.dryRun && cfg.network !== "mainnet") {
    throw new Error("a funded evidence run must use STELLAR_NETWORK=mainnet");
  }
}

async function discoverScrapper(cfg: DemoConfig): Promise<ResolvedAgent> {
  // Secret-free child env: ONLY non-secret config. STELLAR_PRIVATE_KEY / X402_API_KEY are NEVER included.
  const childEnv: Record<string, string> = { STELLAR_NETWORK: cfg.network };
  if (process.env.PATH) childEnv.PATH = process.env.PATH; // let the child resolve `node`
  if (cfg.explorerBaseUrl) {
    childEnv.EXPLORER_BASE_URL = credentialFreeChildUrl("EXPLORER_BASE_URL", cfg.explorerBaseUrl);
  }
  // Discovery does not need the keyed process's RPC override. In particular,
  // provider URLs frequently carry API keys in a path/query, so forwarding
  // STELLAR_RPC_URL would make the "secret-free child" boundary false.
  // Forward only proxy URLs proven credential-free plus non-secret bypass/CA
  // settings needed in corporate and sandboxed networks.
  for (const k of [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
  ]) {
    const v = process.env[k];
    if (v) childEnv[k] = credentialFreeChildUrl(k, v);
  }
  for (const k of ["NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS"]) {
    const v = process.env[k];
    if (v) childEnv[k] = v;
  }
  // Defense-in-depth assertion: never leak secrets to the read-only server.
  for (const k of ["STELLAR_PRIVATE_KEY", "X402_API_KEY"]) {
    if (k in childEnv) throw new Error(`refusing to spawn MCP server with secret ${k} in its env`);
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: [cfg.mcpServerEntry],
    env: childEnv,
    stderr: "inherit",
  });
  const mcp = new Client({ name: "x402-demo", version: "1.0.0" });

  try {
    await mcp.connect(transport);

    const found = await mcp.callTool({
      name: "find_agent",
      arguments: { query: "paid web scrapper agent with good reputation", x402: true, limit: 5 },
    });
    const findResult = requireMcpStructuredContent("find_agent", found);
    const hit = pickScrapper(findResult.agents);
    if (!isRecord(hit.capabilities) || hit.capabilities.x402 !== true) {
      throw new Error(`find_agent: agent ${SCRAPPER_AGENT_ID} is missing capabilities.x402=true`);
    }
    const agentId = SCRAPPER_AGENT_ID;

    const prof = await mcp.callTool({ name: "get_agent_profile", arguments: { agent: agentId } });
    const profileResult = requireMcpStructuredContent("get_agent_profile", prof);
    if (!isRecord(profileResult.profile)) {
      throw new Error("get_agent_profile: structuredContent.profile must be an object");
    }
    const profile = profileResult.profile;
    if (profile.id !== agentId) {
      throw new Error(`get_agent_profile: profile.id=${String(profile.id)} does not match requested agent ${agentId}`);
    }

    const decl = isRecord(profile.selfDeclared) ? profile.selfDeclared : {};
    return {
      agentId: profile.id,
      name: typeof decl?.name === "string" ? decl.name : null,
      endpoint: resolveEndpoint(profile),
      wallet: typeof profile?.wallet === "string" && profile.wallet ? profile.wallet : null,
      owner: typeof profile?.owner === "string" ? profile.owner : null,
      x402Enabled: profile?.capabilities?.x402 === true,
    };
  } finally {
    await mcp.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// [3/4] Pay via x402 (manual 402 flow) and receive the result
// ---------------------------------------------------------------------------

interface PayResult {
  resultHash: string;
  resultOk: boolean;
  paymentTxHash: string;
  /** SHA-256 of the signed Soroban invocation + authorization entries. */
  paymentAuthorizationHash: string;
  settlementLedger: number;
  settlementConfirmedAt: string;
  payTo: string;
  price: string;
  asset: string;
  challengeNetwork: string;
  journalPath: string;
  requestIdentity: CanonicalRequestIdentity;
  paymentTransactionXdrSha256: string;
  signedPaymentPayloadSha256: string;
  paymentResponseHeaderBytes: number;
  paymentResponseHeaderSha256: string;
  settlementRecomputedTxHash: string;
  settlementTransactionXdr: string;
}

export interface PaymentSubmission {
  response: Response;
  authorizationHash: string;
  paymentTransactionXdrSha256: string;
  signedPaymentPayloadSha256: string;
  paymentRecoveryArtifactPath: string;
  paymentRecoveryArtifactSha256: string;
  submittedAtMs: number;
  journalPath: string;
}

export interface PaymentAttemptContext {
  startedAt: string;
  payerPublicKey: string;
  agentId: number;
  endpoint: string;
  challengeNetwork: string;
  asset: string;
  payTo: string;
  price: string;
  canonicalEndpoint: string;
  requestMethod: string;
  requestBodySha256: string;
  requestDigest: string;
  idempotencyKey: string;
  paymentTransactionXdr: string;
  signedPaymentPayload: unknown;
}

export interface PaymentRecoveryArtifact extends CanonicalRequestIdentity {
  version: 1;
  kind: "x402_signed_payment_recovery";
  recordedAt: string;
  endpoint: string;
  challengeNetwork: string;
  asset: string;
  payTo: string;
  price: string;
  paymentAuthorizationHash: string;
  paymentTransactionXdr: string;
  /** Exact compact JSON serialization used as the signed-payload recovery source. */
  signedPaymentPayloadJson: string;
}

export interface PaymentRecoveryArtifactReference {
  path: string;
  sha256: string;
}

export interface ValidatedChallenge {
  /** A singleton copy prevents the x402 client from selecting an unchecked alternative. */
  required: PaymentRequired;
  requirement: PaymentRequirements;
  priceUsdc: string;
}

function buildX402(cfg: DemoConfig): { client: x402Client; http: x402HTTPClient } {
  const secret = process.env.STELLAR_PRIVATE_KEY;
  if (!secret) throw new Error("STELLAR_PRIVATE_KEY required to sign the x402 payment");
  const signer = createEd25519Signer(secret, cfg.caip2);
  const client = new x402Client().register(
    STELLAR_WILDCARD_CAIP2, // handles stellar:pubnet + stellar:testnet
    new ExactStellarScheme(signer, { url: cfg.rpcUrl }),
  );
  return { client, http: new x402HTTPClient(client) };
}

/**
 * Build a request that cannot follow a redirect. In particular, a signed
 * PAYMENT-SIGNATURE header is a bearer-like capability and must never be
 * replayed by fetch to another origin after a 30x response.
 */
export function scrapeInit(cfg: DemoConfig, extraHeaders?: Record<string, string>): RequestInit {
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  const init: RequestInit = { method: cfg.scrapeMethod, headers, redirect: "error" };
  if (cfg.scrapeMethod !== "GET" && cfg.scrapeMethod !== "HEAD" && cfg.scrapeBody != null) {
    headers["content-type"] = "application/json";
    init.body = cfg.scrapeBody;
  }
  return init;
}

export interface CanonicalRequestIdentity {
  payerPublicKey: string;
  agentId: number;
  canonicalEndpoint: string;
  requestMethod: string;
  requestBodySha256: string;
  requestDigest: string;
  idempotencyKey: string;
}

interface FundedRunLockRecord extends CanonicalRequestIdentity {
  version: 1;
  state: "locked" | "payment_submission_prepared";
  startedAt: string;
  journalPath?: string;
  paymentAuthorizationHash?: string;
  paymentRecoveryArtifactPath?: string;
  paymentRecoveryArtifactSha256?: string;
  updatedAt: string;
}

export interface FundedRunLock {
  path: string;
  identity: CanonicalRequestIdentity;
  markPaymentSubmissionPrepared(submission: {
    journalPath: string;
    authorizationHash: string;
    paymentRecoveryArtifactPath: string;
    paymentRecoveryArtifactSha256: string;
  }): Promise<void>;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * RFC-8785 is larger than this demo needs, but parsed JSON still needs a stable
 * ordering boundary so whitespace or object-key order cannot bypass replay
 * protection. JSON numbers are emitted by JSON.stringify after rejecting
 * non-finite values; arrays retain their semantic order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("SCRAPE_BODY contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error(`SCRAPE_BODY contains an unsupported JSON value (${typeof value})`);
}

/**
 * Bind a funded attempt to payer + agent + the semantic HTTP request. The
 * canonical request digest deliberately excludes challenge fields: those are
 * independently source-pinned and journaled after the server returns them.
 */
export function canonicalRequestIdentity(
  cfg: DemoConfig,
  payerPublicKey: string,
  agentId: number,
  endpoint: string,
): CanonicalRequestIdentity {
  const payer = assertPublicKey("payer", payerPublicKey);
  if (!Number.isSafeInteger(agentId) || agentId < 0) throw new Error("agentId must be a non-negative safe integer");
  const parsedEndpoint = new URL(endpoint);
  if (
    parsedEndpoint.protocol !== "https:" ||
    parsedEndpoint.username ||
    parsedEndpoint.password ||
    parsedEndpoint.hash
  ) {
    throw new Error("funded endpoint must be canonical HTTPS without credentials or fragment");
  }
  const canonicalEndpoint = parsedEndpoint.toString();
  const requestMethod = cfg.scrapeMethod.toUpperCase();
  if (requestMethod !== "POST" || cfg.scrapeBody == null) {
    throw new Error("funded request identity requires POST with a JSON body");
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(cfg.scrapeBody);
  } catch {
    throw new Error("SCRAPE_BODY must be valid JSON before creating the funded-run lock");
  }
  const requestBodySha256 = sha256Hex(canonicalJson(parsedBody));
  const requestDigest = sha256Hex(
    JSON.stringify({ canonicalEndpoint, requestMethod, requestBodySha256 }),
  );
  const idempotencyKey = sha256Hex(`${payer}\n${agentId}\n${requestDigest}`);
  return {
    payerPublicKey: payer,
    agentId,
    canonicalEndpoint,
    requestMethod,
    requestBodySha256,
    requestDigest,
    idempotencyKey,
  };
}

function outputJournalPath(startedAt: string, directory = HERE): string {
  return resolve(directory, `run-${startedAt.replace(/[:.]/g, "-")}.journal.jsonl`);
}

async function syncParentDirectory(path: string): Promise<void> {
  await fsyncParentDirectory(path);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeAtomicJsonFile(path, value);
}

function priorAttemptMatches(value: unknown, identity: CanonicalRequestIdentity): boolean {
  if (!isRecord(value)) return false;
  if (
    value.payerPublicKey !== identity.payerPublicKey ||
    value.agentId !== identity.agentId ||
    value.endpoint !== identity.canonicalEndpoint
  ) {
    return false;
  }
  // Legacy evidence did not record a request digest. It is ambiguous, so it
  // blocks every new attempt for the same payer/agent/endpoint until an
  // operator reconciles it.
  return value.requestDigest === undefined || value.requestDigest === identity.requestDigest;
}

async function assertNoPriorFundedAttempt(
  identity: CanonicalRequestIdentity,
  directory: string,
): Promise<void> {
  const names = await readdir(directory);
  for (const name of names.sort()) {
    if (/^run-.*\.journal\.jsonl$/.test(name)) {
      const path = resolve(directory, name);
      const text = await readFile(path, "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        if (!line.trim()) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          throw new Error(`cannot prove replay safety: malformed journal ${path}:${index + 1}`);
        }
        if (
          isRecord(entry) &&
          (entry.event === "payment_submission_prepared" || entry.event === "payment_submitted") &&
          priorAttemptMatches(entry, identity)
        ) {
          throw new Error(
            `REPLAY_BLOCKED: prior funded attempt exists in ${path}; reconcile it manually and do not pay again`,
          );
        }
      }
    } else if (/^run-.*\.json$/.test(name)) {
      const path = resolve(directory, name);
      let receipt: unknown;
      try {
        receipt = JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw new Error(`cannot prove replay safety: malformed receipt ${path}`);
      }
      if (isRecord(receipt) && receipt.dryRun !== true && priorAttemptMatches(receipt, identity)) {
        throw new Error(
          `REPLAY_BLOCKED: completed or ambiguous funded receipt exists at ${path}; refusing duplicate payment`,
        );
      }
    }
  }
}

/**
 * Acquire the permanent per-request replay record. The file is intentionally
 * never auto-deleted: after any crash, timeout, or successful run it remains
 * the fail-closed idempotency gate. Manual deletion is allowed only after
 * reconciling the named journal and both ledgers.
 */
export async function acquireFundedRunLock(
  identity: CanonicalRequestIdentity,
  startedAt: string,
  directory = HERE,
): Promise<FundedRunLock> {
  await assertNoPriorFundedAttempt(identity, directory);
  const path = resolve(directory, `x402-funded-${identity.idempotencyKey}.lock.json`);
  const initial: FundedRunLockRecord = {
    version: 1,
    state: "locked",
    ...identity,
    startedAt,
    updatedAt: new Date().toISOString(),
  };
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new Error(
        `REPLAY_BLOCKED: exclusive funded-run lock already exists at ${path}; reconcile it manually`,
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(initial, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncParentDirectory(path);

  return {
    path,
    identity,
    async markPaymentSubmissionPrepared(submission): Promise<void> {
      const current = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (
        !isRecord(current) ||
        current.idempotencyKey !== identity.idempotencyKey ||
        current.state !== "locked"
      ) {
        throw new Error("funded-run lock is missing, corrupt, or already advanced");
      }
      if (!isAbsolute(submission.journalPath) || !isAbsolute(submission.paymentRecoveryArtifactPath)) {
        throw new Error("funded-run recovery references must be absolute paths");
      }
      await writeJsonAtomic(path, {
        ...initial,
        state: "payment_submission_prepared",
        journalPath: submission.journalPath,
        paymentAuthorizationHash: assertResultHash(submission.authorizationHash),
        paymentRecoveryArtifactPath: submission.paymentRecoveryArtifactPath,
        paymentRecoveryArtifactSha256: assertResultHash(submission.paymentRecoveryArtifactSha256),
        updatedAt: new Date().toISOString(),
      } satisfies FundedRunLockRecord);
    },
  };
}

/**
 * Explicit operator-only mutex release after reconciling the exact idempotency
 * key. A prepared journal remains a permanent replay gate even after the mutex
 * is removed; this operation never authorizes an automatic full rerun.
 */
export async function releaseReconciledFundedRunLock(
  idempotencyKey: string,
  directory = HERE,
): Promise<void> {
  const key = assertResultHash(idempotencyKey);
  const path = resolve(directory, `x402-funded-${key}.lock.json`);
  const record = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (
    !isRecord(record) ||
    record.idempotencyKey !== key ||
    record.version !== 1 ||
    (record.state !== "locked" && record.state !== "payment_submission_prepared") ||
    typeof record.startedAt !== "string"
  ) {
    throw new Error(`funded-run lock ${path} is malformed or belongs to another request`);
  }
  const journalPath = outputJournalPath(record.startedAt, directory);

  if (record.state === "payment_submission_prepared") {
    if (
      record.journalPath !== journalPath ||
      typeof record.paymentRecoveryArtifactPath !== "string" ||
      !isAbsolute(record.paymentRecoveryArtifactPath) ||
      dirname(resolve(record.paymentRecoveryArtifactPath)) !== resolve(directory) ||
      typeof record.paymentRecoveryArtifactSha256 !== "string"
    ) {
      throw new Error("prepared funded-run lock has missing or out-of-scope recovery references");
    }
    const artifactSha256 = assertResultHash(record.paymentRecoveryArtifactSha256);
    const artifactBytes = await readFile(record.paymentRecoveryArtifactPath);
    if (sha256Hex(artifactBytes) !== artifactSha256) {
      throw new Error("payment recovery artifact digest does not match the funded-run lock");
    }
    let artifact: unknown;
    try {
      artifact = JSON.parse(artifactBytes.toString("utf8"));
    } catch {
      throw new Error("payment recovery artifact is malformed");
    }
    if (
      !isRecord(artifact) ||
      artifact.kind !== "x402_signed_payment_recovery" ||
      artifact.version !== 1 ||
      artifact.idempotencyKey !== key ||
      artifact.paymentAuthorizationHash !== record.paymentAuthorizationHash ||
      typeof artifact.paymentTransactionXdr !== "string" ||
      typeof artifact.signedPaymentPayloadJson !== "string"
    ) {
      throw new Error("payment recovery artifact does not match the prepared funded-run lock");
    }

    const lines = (await readFile(journalPath, "utf8")).split("\n");
    let matchingPreparedEntry = false;
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new Error(`cannot release lock: malformed journal ${journalPath}:${index + 1}`);
      }
      if (
        isRecord(entry) &&
        entry.event === "payment_submission_prepared" &&
        entry.idempotencyKey === key &&
        entry.paymentAuthorizationHash === record.paymentAuthorizationHash &&
        entry.paymentRecoveryArtifactPath === record.paymentRecoveryArtifactPath &&
        entry.paymentRecoveryArtifactSha256 === artifactSha256 &&
        entry.paymentTransactionXdrSha256 === sha256Hex(artifact.paymentTransactionXdr) &&
        entry.signedPaymentPayloadSha256 === sha256Hex(artifact.signedPaymentPayloadJson)
      ) {
        matchingPreparedEntry = true;
      }
    }
    if (!matchingPreparedEntry) {
      throw new Error("cannot release lock: journal has no matching durable payment preparation");
    }
  }

  await appendDurableJsonLine(journalPath, {
    event: "funded_lock_released",
    recordedAt: new Date().toISOString(),
    release: "reviewed_reconciliation",
    reason: "operator-confirmed-ledger-reconciled",
    idempotencyKey: key,
    previousState: record.state,
  } satisfies Extract<RunJournalEntry, { event: "funded_lock_released" }>);
  await unlink(path);
  await syncParentDirectory(path);
}

async function payForService(
  cfg: DemoConfig,
  agent: ResolvedAgent,
  startedAt: string,
  expectedUrl: string,
  requestIdentity: CanonicalRequestIdentity,
  onSubmissionPrepared?: PaymentSubmissionDependencies["onSubmissionPrepared"],
): Promise<PayResult> {
  assertEvidenceTarget(cfg, agent);
  const { client, http } = buildX402(cfg);
  const url = agent.endpoint;

  // 1) First request — expect HTTP 402.
  let first: Response;
  try {
    first = await fetchWithTimeout(fetch, url, scrapeInit(cfg), UNPAID_CHALLENGE_TIMEOUT_MS);
  } catch (error) {
    throw new Error(`initial unpaid x402 challenge request failed: ${redactSensitiveError(error)}`);
  }
  if (first.status !== 402) {
    throw new Error(`expected 402 from ${url}, got ${first.status}`);
  }

  // 2) Decode the payment requirement from the challenge headers.
  let decoded: PaymentRequired;
  try {
    decoded = http.getPaymentRequiredResponse((name) => first.headers.get(name));
  } catch (err) {
    throw new Error(`invalid 402 payment challenge: ${err instanceof Error ? err.message : String(err)}`);
  }
  const validated = validatePaymentChallenge(cfg, decoded);
  // The v2 challenge is header-only. Do not leave an attacker-controlled 402
  // stream open while a real authorization is created.
  await first.body?.cancel().catch(() => undefined);
  const accept = validated.requirement;
  const payTo = accept.payTo;
  const price = accept.amount;
  process.stderr.write(`[pay] challenge: ${validated.priceUsdc} USDC → ${payTo} on ${accept.network}\n`);
  if (agent.wallet && agent.wallet !== payTo) {
    process.stderr.write(`[pay] note: profile.wallet ${agent.wallet} != reviewed challenge payTo ${payTo}\n`);
  }

  // 3) + 4) Sign ONCE and submit — expect HTTP 200 with the result.
  // We deliberately do NOT auto-resubmit on a post-payment 402: a 402 returned
  // AFTER submitting a payment can mean the facilitator already settled on-chain
  // but the HTTP response failed downstream, and minting a second signed payload
  // would double-spend real USDC. Create a durable journal before submission,
  // then surface it for ledger reconciliation; never mint a second payment.
  const payerPublicKey = assertPublicKey("payer", cfg.payerPublicKey);
  const submission = await settleOnce(
    client,
    http,
    url,
    cfg,
    validated.required,
    {
      startedAt,
      payerPublicKey,
      agentId: agent.agentId,
      endpoint: agent.endpoint,
      challengeNetwork: accept.network,
      asset: accept.asset,
      payTo,
      price,
      canonicalEndpoint: requestIdentity.canonicalEndpoint,
      requestMethod: requestIdentity.requestMethod,
      requestBodySha256: requestIdentity.requestBodySha256,
      requestDigest: requestIdentity.requestDigest,
      idempotencyKey: requestIdentity.idempotencyKey,
    },
    onSubmissionPrepared,
  );
  const paid = submission.response;
  let claimedPaymentTxHash: string | null = null;
  let settlementConfirmed = false;
  try {
    const claim = await captureUntrustedSettlementClaim(
      paid,
      { payer: payerPublicKey, network: accept.network, amount: accept.amount },
      startedAt,
      appendRunJournal,
    );
    claimedPaymentTxHash = claim.paymentTxHash;
    if (claim.journalError) {
      throw new Error(`settlement claim could not be durably journaled: ${claim.journalError}`);
    }
    if (paid.status === 402) {
      throw new Error(
        `HTTP 402 after submitting the signed payment; settlement is unknown${
          claimedPaymentTxHash ? ` (transaction claim ${claimedPaymentTxHash})` : ""
        }`,
      );
    }
    if (paid.status !== 200) throw new Error(`expected HTTP 200 after payment, got ${paid.status}`);

    // 5) Treat PAYMENT-RESPONSE as an untrusted claim. Validate its full
    // SettleResponse tuple, then independently require a successful RPC transaction
    // containing exactly the expected USDC transfer before consuming the result or
    // writing reputation.
    if (!claim.response || !claim.paymentResponseHeaderSha256) {
      throw new Error("PAYMENT-RESPONSE settlement header is missing, oversized, or malformed");
    }
    const paymentTxHash = validateSettlementResponse(claim.response, {
      payer: payerPublicKey,
      network: accept.network,
      amount: accept.amount,
    });
    const onchain = await verifySettlementOnchain(cfg, paymentTxHash, {
      payer: payerPublicKey,
      payTo,
      asset: accept.asset,
      amount: accept.amount,
      submittedAtMs: submission.submittedAtMs,
      authorizationHash: submission.authorizationHash,
      networkPassphrase: cfg.stellar.networkPassphrase,
    });
    settlementConfirmed = true;
    await appendRunJournal(startedAt, {
      event: "settlement_confirmed",
      recordedAt: new Date().toISOString(),
      paymentTxHash,
      settlementRecomputedTxHash: onchain.recomputedTxHash,
      settlementLedger: onchain.ledger,
      settlementConfirmedAt: onchain.confirmedAt,
      settlementTransactionXdr: onchain.transactionXdr,
    });
    const { result, resultHash } = await readPaidResult(paid, PAID_RESULT_TIMEOUT_MS);
    const resultOk = isSuccessfulResult(result, expectedUrl);
    await appendRunJournal(startedAt, {
      event: "result_hashed",
      recordedAt: new Date().toISOString(),
      resultHash,
      resultOk,
    });
    return {
      resultHash,
      resultOk,
      paymentTxHash,
      paymentAuthorizationHash: submission.authorizationHash,
      payTo,
      price,
      asset: accept.asset,
      challengeNetwork: accept.network,
      settlementLedger: onchain.ledger,
      settlementConfirmedAt: onchain.confirmedAt,
      settlementRecomputedTxHash: onchain.recomputedTxHash,
      journalPath: submission.journalPath,
      requestIdentity,
      paymentTransactionXdrSha256: submission.paymentTransactionXdrSha256,
      signedPaymentPayloadSha256: submission.signedPaymentPayloadSha256,
      paymentResponseHeaderBytes: claim.paymentResponseHeaderBytes,
      paymentResponseHeaderSha256: claim.paymentResponseHeaderSha256,
      settlementTransactionXdr: onchain.transactionXdr,
    };
  } catch (error) {
    const markerFailure = await appendRecoveryMarker(appendRunJournal, startedAt, {
      event: "payment_outcome_unknown",
      recordedAt: new Date().toISOString(),
      stage: "post_response_processing",
      httpStatus: paid.status,
      settlementStatus: settlementConfirmed ? "confirmed" : "unknown",
      paymentTxHash: claimedPaymentTxHash ?? undefined,
    });
    const state = settlementConfirmed ? "PAYMENT_SETTLED_RESULT_UNKNOWN" : "PAYMENT_SUBMITTED";
    throw new Error(
      `${state}: recover from ${submission.journalPath}; DO NOT rerun or create another payment.` +
        `${claimedPaymentTxHash ? ` Reconcile tx=${claimedPaymentTxHash}.` : ""} ` +
        `${markerFailure ? `Recovery marker also failed: ${markerFailure}. ` : ""}` +
        `Cause: ${redactSensitiveError(error)}`,
    );
  }
}

function maxPriceBaseUnits(cfg: DemoConfig): bigint {
  const scaled = cfg.maxPriceUsdc * 10 ** USDC_DECIMALS;
  if (!Number.isSafeInteger(scaled)) {
    throw new Error(`MAX_PRICE_USDC must have at most ${USDC_DECIMALS} decimals and fit a safe integer`);
  }
  return BigInt(scaled);
}

function formatUsdcBaseUnits(amount: bigint): string {
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const whole = amount / scale;
  const fractional = (amount % scale).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

/** Validate every server-controlled challenge field before a signature exists. */
export function validatePaymentChallenge(cfg: DemoConfig, required: PaymentRequired): ValidatedChallenge {
  if (!isRecord(required) || required.x402Version !== 2) {
    throw new Error(`unsupported x402 challenge version: ${String((required as any)?.x402Version)}`);
  }
  if (!Array.isArray(required.accepts) || required.accepts.length !== 1) {
    throw new Error(
      `402 challenge must contain exactly one payment requirement; got ${Array.isArray(required.accepts) ? required.accepts.length : "invalid"}`,
    );
  }
  if (!isRecord(required.resource) || required.resource.url !== SCRAPPER_ALLOWED_ENDPOINTS[0]) {
    throw new Error(
      `resource mismatch: challenge=${String((required.resource as any)?.url)} expected=${SCRAPPER_ALLOWED_ENDPOINTS[0]}`,
    );
  }
  const accept = required.accepts[0];
  if (!isRecord(accept)) throw new Error("402 payment requirement must be an object");
  if (accept.scheme !== "exact") throw new Error(`scheme mismatch: challenge=${String(accept.scheme)} expected=exact`);
  if (accept.network !== cfg.caip2) {
    throw new Error(`network mismatch: challenge=${String(accept.network)} expected=${cfg.caip2}`);
  }
  const expectedAsset = cfg.network === "mainnet" ? USDC_CONTRACT_MAINNET : USDC_CONTRACT_TESTNET;
  if (accept.asset !== expectedAsset) {
    throw new Error(
      `asset mismatch: challenge=${String(accept.asset)} expected USDC=${expectedAsset} — refusing unexpected asset`,
    );
  }
  if (!/^\d+$/.test(String(accept.amount ?? ""))) {
    throw new Error(`challenge amount is not a base-unit integer: ${JSON.stringify(accept.amount)}`);
  }
  const amount = BigInt(accept.amount);
  if (amount <= 0n) throw new Error("challenge amount must be greater than zero for paid evidence");
  const maximum = maxPriceBaseUnits(cfg);
  if (amount > maximum) {
    throw new Error(
      `price ${formatUsdcBaseUnits(amount)} USDC exceeds MAX_PRICE_USDC=${cfg.maxPriceUsdc} — refusing`,
    );
  }
  const payTo = assertPublicKey("challenge.payTo", typeof accept.payTo === "string" ? accept.payTo : null);
  if (payTo !== SCRAPPER_EXPECTED_PAY_TO) {
    throw new Error(`payTo mismatch: challenge=${payTo} expected=${SCRAPPER_EXPECTED_PAY_TO}`);
  }
  if (payTo === cfg.payerPublicKey) {
    throw new Error(`challenge payTo is the payer itself (${payTo}) — refusing self-payment`);
  }
  if (
    !Number.isSafeInteger(accept.maxTimeoutSeconds) ||
    accept.maxTimeoutSeconds <= 0 ||
    accept.maxTimeoutSeconds > MAX_CHALLENGE_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `maxTimeoutSeconds must be an integer in 1..${MAX_CHALLENGE_TIMEOUT_SECONDS}; got ${String(
        accept.maxTimeoutSeconds,
      )}`,
    );
  }
  if (!isRecord(accept.extra) || accept.extra.areFeesSponsored !== true) {
    throw new Error("Stellar exact payment requires extra.areFeesSponsored=true");
  }

  const requirement = accept as PaymentRequirements;
  return {
    required: { ...required, accepts: [requirement] },
    requirement,
    priceUsdc: formatUsdcBaseUnits(amount),
  };
}

export type RunJournalAppender = (startedAt: string, entry: RunJournalEntry) => Promise<string>;

export interface PaymentSubmissionDependencies {
  /** Unit-test seam; production always uses the process-global fetch. */
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Unit-test seam; production always uses the fsync-backed appendRunJournal. */
  appendJournal?: RunJournalAppender;
  /** Unit-test seam; production atomically writes a private, fsync-backed recovery artifact. */
  persistRecoveryArtifact?: (
    startedAt: string,
    artifact: PaymentRecoveryArtifact,
  ) => Promise<PaymentRecoveryArtifactReference>;
  nowMs?: () => number;
  /** Unit-test seam; production uses SIGNED_SERVICE_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  /** Runs after both recovery artifact and journal are durable, before fetch. */
  onSubmissionPrepared?: (submission: {
    journalPath: string;
    authorizationHash: string;
    paymentRecoveryArtifactPath: string;
    paymentRecoveryArtifactSha256: string;
  }) => Promise<void>;
}

/** Bound a stage even when an SDK transport has no request-timeout option. */
export async function withStageDeadline<T>(
  label: string,
  timeoutMs: number,
  operation: () => Promise<T>,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${label} timeout must be a positive integer; got ${String(timeoutMs)}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) void Promise.resolve(onTimeout()).catch(() => undefined);
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchWithTimeout(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`service request timeout must be a positive integer; got ${String(timeoutMs)}`);
  }
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const relayAbort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) relayAbort();
  else upstreamSignal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`service request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    // This bounds receipt of response headers. Paid-body consumption has its
    // own deadline because fetch resolves before a streaming body completes.
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", relayAbort);
  }
}

async function appendRecoveryMarker(
  appendJournal: RunJournalAppender,
  startedAt: string,
  entry: Extract<RunJournalEntry, { event: "payment_outcome_unknown" | "feedback_outcome_unknown" }>,
): Promise<string | null> {
  try {
    await appendJournal(startedAt, entry);
    return null;
  } catch (error) {
    return redactSensitiveError(error);
  }
}

/**
 * Persist the signed-payment identity before the first byte can leave this
 * process, then submit exactly once. This narrow seam is deliberately free of
 * signing logic so the crash/retry state machine can be tested without keys or
 * network access.
 */
export async function submitSignedPaymentRequest(
  url: string,
  init: RequestInit,
  authorizationHash: string,
  attempt: PaymentAttemptContext,
  dependencies: PaymentSubmissionDependencies = {},
): Promise<PaymentSubmission> {
  const appendJournal = dependencies.appendJournal ?? appendRunJournal;
  const persistRecoveryArtifact =
    dependencies.persistRecoveryArtifact ?? writePaymentRecoveryArtifact;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const nowMs = dependencies.nowMs ?? Date.now;
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? SIGNED_SERVICE_TIMEOUT_MS;
  const submittedAtMs = nowMs();
  const canonicalAuthorizationHash = assertResultHash(authorizationHash);
  if (typeof attempt.paymentTransactionXdr !== "string" || attempt.paymentTransactionXdr.length === 0) {
    throw new Error("signed payment transaction XDR is missing; refusing to submit");
  }
  let signedPaymentPayloadJson: string;
  try {
    const serialized = JSON.stringify(attempt.signedPaymentPayload);
    if (serialized === undefined) throw new Error("payload serialized to undefined");
    signedPaymentPayloadJson = serialized;
  } catch {
    throw new Error("signed payment payload is not durably serializable; refusing to submit");
  }
  const paymentTransactionXdrSha256 = sha256Hex(attempt.paymentTransactionXdr);
  const signedPaymentPayloadSha256 = sha256Hex(signedPaymentPayloadJson);
  let recoveryArtifact: PaymentRecoveryArtifactReference;
  try {
    recoveryArtifact = await persistRecoveryArtifact(attempt.startedAt, {
      version: 1,
      kind: "x402_signed_payment_recovery",
      recordedAt: new Date(submittedAtMs).toISOString(),
      payerPublicKey: attempt.payerPublicKey,
      agentId: attempt.agentId,
      endpoint: attempt.endpoint,
      challengeNetwork: attempt.challengeNetwork,
      asset: attempt.asset,
      payTo: attempt.payTo,
      price: attempt.price,
      canonicalEndpoint: attempt.canonicalEndpoint,
      requestMethod: attempt.requestMethod,
      requestBodySha256: attempt.requestBodySha256,
      requestDigest: attempt.requestDigest,
      idempotencyKey: attempt.idempotencyKey,
      paymentAuthorizationHash: canonicalAuthorizationHash,
      paymentTransactionXdr: attempt.paymentTransactionXdr,
      signedPaymentPayloadJson,
    });
    if (!isAbsolute(recoveryArtifact.path)) {
      throw new Error("recovery artifact path is not absolute");
    }
    recoveryArtifact = {
      path: recoveryArtifact.path,
      sha256: assertResultHash(recoveryArtifact.sha256),
    };
  } catch (error) {
    throw new Error(
      `payment recovery artifact could not be durably created; refusing to submit: ${redactSensitiveError(error)}`,
    );
  }
  let journalPath: string;
  try {
    journalPath = await appendJournal(attempt.startedAt, {
      event: "payment_submission_prepared",
      recordedAt: new Date(submittedAtMs).toISOString(),
      payerPublicKey: attempt.payerPublicKey,
      agentId: attempt.agentId,
      endpoint: attempt.endpoint,
      challengeNetwork: attempt.challengeNetwork,
      asset: attempt.asset,
      payTo: attempt.payTo,
      price: attempt.price,
      paymentAuthorizationHash: canonicalAuthorizationHash,
      canonicalEndpoint: attempt.canonicalEndpoint,
      requestMethod: attempt.requestMethod,
      requestBodySha256: attempt.requestBodySha256,
      requestDigest: attempt.requestDigest,
      idempotencyKey: attempt.idempotencyKey,
      paymentTransactionXdrSha256,
      signedPaymentPayloadSha256,
      paymentRecoveryArtifactPath: recoveryArtifact.path,
      paymentRecoveryArtifactSha256: recoveryArtifact.sha256,
    });
  } catch (error) {
    throw new Error(
      `payment journal could not be durably created; refusing to submit: ${redactSensitiveError(error)}`,
    );
  }

  try {
    await dependencies.onSubmissionPrepared?.({
      journalPath,
      authorizationHash: canonicalAuthorizationHash,
      paymentRecoveryArtifactPath: recoveryArtifact.path,
      paymentRecoveryArtifactSha256: recoveryArtifact.sha256,
    });
  } catch (error) {
    throw new Error(
      `funded-run lock could not be durably advanced; refusing to submit: ${redactSensitiveError(error)}`,
    );
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, init, requestTimeoutMs);
  } catch (error) {
    const markerFailure = await appendRecoveryMarker(appendJournal, attempt.startedAt, {
      event: "payment_outcome_unknown",
      recordedAt: new Date(nowMs()).toISOString(),
      stage: "signed_request",
      settlementStatus: "unknown",
    });
    throw new Error(
      "PAYMENT_OUTCOME_UNKNOWN: the signed payment request was submitted but no HTTP response was received. " +
        `It may already have settled. Recover from ${journalPath}; DO NOT rerun or create a second payment until ` +
        `the ledger is reconciled.${markerFailure ? ` Recovery marker also failed: ${markerFailure}.` : ""} ` +
        `Cause: ${redactSensitiveError(error)}`,
    );
  }

  try {
    await appendJournal(attempt.startedAt, {
      event: "payment_response_received",
      recordedAt: new Date(nowMs()).toISOString(),
      httpStatus: response.status,
    });
  } catch (error) {
    const markerFailure = await appendRecoveryMarker(appendJournal, attempt.startedAt, {
      event: "payment_outcome_unknown",
      recordedAt: new Date(nowMs()).toISOString(),
      stage: "response_journal",
      httpStatus: response.status,
      settlementStatus: "unknown",
    });
    throw new Error(
      `PAYMENT_OUTCOME_UNKNOWN: HTTP ${response.status} was received, but recovery journal ${journalPath} ` +
        `could not be advanced. DO NOT rerun or create another payment.` +
        `${markerFailure ? ` Recovery marker also failed: ${markerFailure}.` : ""} ` +
        `Cause: ${redactSensitiveError(error)}`,
    );
  }

  return {
    response,
    authorizationHash: canonicalAuthorizationHash,
    paymentTransactionXdrSha256,
    signedPaymentPayloadSha256,
    paymentRecoveryArtifactPath: recoveryArtifact.path,
    paymentRecoveryArtifactSha256: recoveryArtifact.sha256,
    submittedAtMs,
    journalPath,
  };
}

async function settleOnce(
  client: x402Client,
  http: x402HTTPClient,
  url: string,
  cfg: DemoConfig,
  required: PaymentRequired,
  attempt: Omit<PaymentAttemptContext, "paymentTransactionXdr" | "signedPaymentPayload">,
  onSubmissionPrepared?: PaymentSubmissionDependencies["onSubmissionPrepared"],
): Promise<PaymentSubmission> {
  let payload: PaymentPayload;
  try {
    payload = await client.createPaymentPayload(required);
  } catch (err) {
    throw new Error(`payment creation failed (USDC/trustline/RPC?): ${err instanceof Error ? err.message : String(err)}`);
  }
  const transactionXdr = payload.payload.transaction;
  if (typeof transactionXdr !== "string" || transactionXdr.length === 0) {
    throw new Error("payment creation returned no Stellar transaction XDR");
  }
  const authorizationHash = paymentAuthorizationHash(transactionXdr, cfg.stellar.networkPassphrase);
  const paymentHeaders = http.encodePaymentSignatureHeader(payload);
  return submitSignedPaymentRequest(
    url,
    scrapeInit(cfg, paymentHeaders),
    authorizationHash,
    {
      ...attempt,
      paymentTransactionXdr: transactionXdr,
      signedPaymentPayload: payload,
    },
    { onSubmissionPrepared },
  );
}

function decodeSettlementResponse(header: string | null): SettleResponse {
  if (!header) throw new Error("PAYMENT-RESPONSE settlement header is missing");
  try {
    return decodePaymentResponseHeader(header);
  } catch (error) {
    throw new Error(
      `invalid PAYMENT-RESPONSE settlement header: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface SettlementClaimCapture {
  response: SettleResponse | null;
  paymentTxHash: string | null;
  paymentResponseHeaderBytes: number;
  paymentResponseHeaderSha256: string | null;
  headerPresent: boolean;
  decoded: boolean;
  journalError: string | null;
}

/**
 * Persist the server's transaction claim before asking RPC about it. This is
 * deliberately labeled untrusted: it is a recovery handle, never finality.
 * Signed 402 responses can carry a failed-settlement PAYMENT-RESPONSE with a
 * transaction hash, so capture is best-effort for every signed response.
 */
export async function captureUntrustedSettlementClaim(
  response: Response,
  expected: { payer: string; network: string; amount: string },
  startedAt: string,
  appendJournal: RunJournalAppender,
): Promise<SettlementClaimCapture> {
  const header = response.headers.get("PAYMENT-RESPONSE");
  const headerBytes = header === null ? 0 : Buffer.byteLength(header, "utf8");
  let decoded: SettleResponse | null = null;
  if (header && headerBytes <= MAX_SETTLEMENT_HEADER_BYTES) {
    try {
      decoded = decodeSettlementResponse(header);
    } catch {
      // The caller still records that a header existed. Never copy malformed
      // header bytes into the journal or an operator-facing error.
    }
  }

  let paymentTxHash: string | null = null;
  if (isRecord(decoded)) {
    try {
      paymentTxHash = assertTransactionHash("settlement claim transaction", decoded.transaction);
    } catch {
      // A missing/malformed hash remains null and cannot become a lookup key.
    }
  }
  const claimedNetwork =
    isRecord(decoded) && typeof decoded.network === "string" && decoded.network.length <= 128
      ? decoded.network
      : null;
  let claimedPayer: string | null = null;
  if (isRecord(decoded) && typeof decoded.payer === "string") {
    try {
      claimedPayer = assertPublicKey("settlement claim payer", decoded.payer);
    } catch {
      // A malformed payer remains null; only normalized recovery facts are journaled.
    }
  }
  const claimedAmount =
    isRecord(decoded) && typeof decoded.amount === "string" && /^\d{1,40}$/.test(decoded.amount)
      ? decoded.amount
      : null;

  let journalError: string | null = null;
  try {
    await appendJournal(startedAt, {
      event: "settlement_claim_received",
      recordedAt: new Date().toISOString(),
      httpStatus: response.status,
      headerPresent: header !== null,
      decoded: decoded !== null,
      claimSuccess: isRecord(decoded) && decoded.success === true,
      networkMatches: isRecord(decoded) && decoded.network === expected.network,
      payerMatches: isRecord(decoded) && decoded.payer === expected.payer,
      paymentTxHash,
      paymentResponseHeaderBytes: headerBytes,
      paymentResponseHeaderSha256: header === null ? null : sha256Hex(header),
      claimedNetwork,
      claimedPayer,
      claimedAmount,
    });
  } catch (error) {
    // Return the claim even when storage failed so the caller can include the
    // exact recovery hash in its unknown-outcome marker and operator error.
    journalError = redactSensitiveError(error);
  }
  return {
    response: decoded,
    paymentTxHash,
    paymentResponseHeaderBytes: headerBytes,
    paymentResponseHeaderSha256: header === null ? null : sha256Hex(header),
    headerPresent: header !== null,
    decoded: decoded !== null,
    journalError,
  };
}

export interface SettlementResponseExpectation {
  payer: string;
  network: string;
  amount: string;
}

/** Validate the server-supplied settlement receipt before touching RPC. */
export function validateSettlementResponse(
  response: SettleResponse,
  expected: SettlementResponseExpectation,
): string {
  if (!isRecord(response) || response.success !== true) {
    // errorReason/errorMessage are untrusted resource-server strings and may
    // reflect the signed PAYMENT-SIGNATURE capability. Never echo them.
    throw new Error("x402 settlement reported failure");
  }
  if (response.network !== expected.network) {
    throw new Error(
      `settlement network mismatch: response=${String(response.network)} expected=${expected.network}`,
    );
  }
  if (response.payer !== expected.payer) {
    throw new Error(`settlement payer mismatch: response=${String(response.payer)} expected=${expected.payer}`);
  }
  if (response.amount !== undefined && response.amount !== expected.amount) {
    throw new Error(
      `settlement amount mismatch: response=${String(response.amount)} expected=${expected.amount}`,
    );
  }
  return assertTransactionHash("x402 settlement transaction", response.transaction);
}

interface TransferFact {
  asset: string;
  from: string;
  to: string;
  amount: bigint;
}

interface OnchainSettlementExpectation {
  payer: string;
  payTo: string;
  asset: string;
  amount: string;
  submittedAtMs: number;
  authorizationHash: string;
  networkPassphrase: string;
}

interface OnchainSettlementProof {
  ledger: number;
  confirmedAt: string;
  recomputedTxHash: string;
  transactionXdr: string;
}

/**
 * Bind a facilitator-built settlement envelope back to the exact invocation
 * authorized by this client. The facilitator legitimately changes the source
 * account/sequence and may fee-bump the transaction, so whole-transaction hash
 * equality would reject compliant x402 settlements. The signed Soroban auth
 * entry and host function are preserved across that rebuild and are the stable
 * one-shot authorization identity.
 */
export function paymentAuthorizationHash(
  envelope: string | xdr.TransactionEnvelope,
  networkPassphrase: string,
): string {
  const parsed = TransactionBuilder.fromXDR(envelope, networkPassphrase);
  const transaction = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
  if (transaction.operations.length !== 1 || transaction.operations[0]?.type !== "invokeHostFunction") {
    throw new Error("payment transaction must contain exactly one invokeHostFunction operation");
  }
  const operation = transaction.operations[0];
  if (!Array.isArray(operation.auth) || operation.auth.length !== 1) {
    throw new Error(`payment transaction must contain exactly one Soroban authorization entry; got ${operation.auth?.length ?? 0}`);
  }
  const hash = createHash("sha256");
  hash.update(operation.func.toXDR());
  hash.update(operation.auth[0].toXDR());
  return hash.digest("hex");
}

/** Recompute the canonical outer transaction hash from the returned envelope. */
export function transactionEnvelopeHash(
  envelope: string | xdr.TransactionEnvelope,
  networkPassphrase: string,
): string {
  const parsed = TransactionBuilder.fromXDR(envelope, networkPassphrase);
  return Buffer.from(parsed.hash()).toString("hex");
}

function transferFacts(transaction: Record<string, any>): TransferFact[] {
  const groups = transaction.events?.contractEventsXdr;
  if (!Array.isArray(groups)) throw new Error("confirmed transaction has no parsed contract events");
  const facts: TransferFact[] = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const event of group) {
      try {
        if (event.type().name !== "contract") continue;
        const body = event.body().v0();
        const topics = body.topics();
        if (topics.length < 3 || topics[0].switch().name !== "scvSymbol") continue;
        if (topics[0].sym().toString() !== "transfer") continue;
        const contractId = event.contractId();
        if (!contractId) throw new Error("transfer event has no contract id");
        facts.push({
          asset: Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractId)).toString(),
          from: String(scValToNative(topics[1])),
          to: String(scValToNative(topics[2])),
          amount: BigInt(scValToNative(body.data())),
        });
      } catch (error) {
        throw new Error(
          `could not parse settlement transfer event: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return facts;
}

/** Pure finality/tuple assertion, exported for offline regression tests. */
export function assertOnchainSettlement(
  transaction: unknown,
  txHash: string,
  expected: OnchainSettlementExpectation,
): OnchainSettlementProof {
  if (!isRecord(transaction) || transaction.status !== "SUCCESS") {
    throw new Error(`settlement transaction is not final-success (status=${String((transaction as any)?.status)})`);
  }
  const expectedTxHash = assertTransactionHash("PAYMENT-RESPONSE transaction hash", txHash);
  if (assertTransactionHash("RPC transaction hash", transaction.txHash) !== expectedTxHash) {
    throw new Error("RPC transaction hash does not match PAYMENT-RESPONSE");
  }
  if (!Number.isSafeInteger(transaction.ledger) || transaction.ledger <= 0) {
    throw new Error("settlement transaction has no valid ledger sequence");
  }
  if (!Number.isFinite(transaction.createdAt)) {
    throw new Error("settlement transaction has no valid close time");
  }
  if (!/^[0-9a-f]{64}$/.test(expected.authorizationHash)) {
    throw new Error("expected payment authorization hash is invalid");
  }
  if (!(transaction.envelopeXdr instanceof xdr.TransactionEnvelope)) {
    throw new Error("settlement transaction has no parsed envelope XDR");
  }
  const recomputedTxHash = transactionEnvelopeHash(transaction.envelopeXdr, expected.networkPassphrase);
  if (recomputedTxHash !== expectedTxHash) {
    throw new Error("settlement envelope hash does not match PAYMENT-RESPONSE transaction hash");
  }
  const confirmedAuthorizationHash = paymentAuthorizationHash(
    transaction.envelopeXdr,
    expected.networkPassphrase,
  );
  if (confirmedAuthorizationHash !== expected.authorizationHash) {
    throw new Error("settlement transaction does not contain this payment's signed Soroban authorization");
  }
  // SDK v15 exposes `createdAt` only as whole Unix seconds. This check cannot
  // distinguish two events inside one second, so authorizationHash above is the
  // replay boundary; time remains defense-in-depth for older-ledger receipts.
  if (transaction.createdAt < Math.floor(expected.submittedAtMs / 1_000)) {
    throw new Error("settlement transaction predates this payment submission");
  }
  const facts = transferFacts(transaction);
  if (facts.length !== 1) {
    throw new Error(`expected exactly one on-chain transfer event; got ${facts.length}`);
  }
  const [fact] = facts;
  if (
    fact.asset !== expected.asset ||
    fact.from !== expected.payer ||
    fact.to !== expected.payTo ||
    fact.amount !== BigInt(expected.amount)
  ) {
    throw new Error("on-chain transfer does not match expected asset/payer/payee/amount tuple");
  }
  return {
    ledger: transaction.ledger,
    confirmedAt: new Date(transaction.createdAt * 1_000).toISOString(),
    recomputedTxHash,
    transactionXdr: transaction.envelopeXdr.toXDR("base64"),
  };
}

async function verifySettlementOnchain(
  cfg: DemoConfig,
  txHash: string,
  expected: OnchainSettlementExpectation,
): Promise<OnchainSettlementProof> {
  const server = new rpc.Server(cfg.rpcUrl, { allowHttp: false });
  return withStageDeadline("settlement RPC verification", SETTLEMENT_RPC_TIMEOUT_MS, async () => {
    let transaction: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      transaction = await server.getTransaction(txHash);
      if (isRecord(transaction) && transaction.status !== "NOT_FOUND") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    return assertOnchainSettlement(transaction, txHash, expected);
  });
}

export function assertTransactionHash(label: string, hash: unknown): string {
  if (typeof hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(`${label} is missing or not a 32-byte hex hash`);
  }
  return hash.toLowerCase();
}

export function assertResultHash(hash: unknown): string {
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error("resultHash is missing or not a lowercase SHA-256 hex digest");
  }
  return hash;
}

export async function readPaidResult(
  res: Response,
  timeoutMs = PAID_RESULT_TIMEOUT_MS,
): Promise<{ result: unknown; resultHash: string }> {
  const declaredLength = res.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) throw new Error("paid service returned an invalid Content-Length");
    if (BigInt(declaredLength) > BigInt(MAX_PAID_RESULT_BYTES)) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`paid service response exceeds ${MAX_PAID_RESULT_BYTES} bytes`);
    }
  }
  if (!res.body) throw new Error("paid service returned an empty response body");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    await withStageDeadline(
      "paid result body",
      timeoutMs,
      async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_PAID_RESULT_BYTES) {
            await reader.cancel("paid result too large").catch(() => undefined);
            throw new Error(`paid service response exceeds ${MAX_PAID_RESULT_BYTES} bytes`);
          }
          chunks.push(value);
        }
      },
      () => reader.cancel("paid result body timed out"),
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may finish asynchronously on custom streams. The timeout
      // still terminates this funded run; release is best-effort cleanup.
    }
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  if (bytes.length === 0) throw new Error("paid service returned an empty response body");
  const resultHash = assertResultHash(createHash("sha256").update(bytes).digest("hex"));
  const text = bytes.toString("utf8");
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    result = { raw: text.slice(0, 2000) };
  }
  return { result, resultHash };
}

/**
 * The deployed Scrapper contract is deliberately narrow: its HTTP wrapper
 * returns exactly `{ success: true, data: string }`, and the string emitted by
 * `formatOutput()` begins with `URL:` and contains a `Content:` section. Generic
 * truthy JSON, queue acknowledgements, arrays, and status/code objects are not
 * completed scrapes and must never earn acceptance evidence or a 95 score.
 */
export function isSuccessfulResult(result: unknown, expectedUrl?: string): boolean {
  if (!isRecord(result) || Array.isArray(result)) return false;
  const keys = Object.keys(result);
  if (keys.length !== 2 || !keys.includes("success") || !keys.includes("data")) return false;
  if (result.success !== true || typeof result.data !== "string" || result.data.trim().length === 0) {
    return false;
  }
  const match = /^URL: (https?:\/\/[^\r\n]+)\r?\n/.exec(result.data);
  const content = /\r?\nContent:\r?\n([\s\S]*)$/.exec(result.data);
  if (!match || !content || content[1].trim().length === 0) return false;
  return expectedUrl === undefined || match[1] === expectedUrl;
}

/** Parse and pin the request whose response is about to receive on-chain credit. */
export function expectedScrapeUrl(cfg: DemoConfig): string {
  if (cfg.scrapeMethod !== "POST" || cfg.scrapeBody == null) {
    throw new Error("the funded Scrapper evidence run requires POST with a JSON body");
  }
  let body: unknown;
  try {
    body = JSON.parse(cfg.scrapeBody);
  } catch {
    throw new Error("SCRAPE_BODY must be valid JSON before any payment is attempted");
  }
  if (!isRecord(body) || typeof body.url !== "string" || body.url.length === 0) {
    throw new Error('SCRAPE_BODY must be an object with a non-empty string "url"');
  }
  if (body.evaluationMode === true) {
    throw new Error("evaluationMode has a different response contract and is not valid acceptance evidence");
  }
  let parsed: URL;
  try {
    parsed = new URL(body.url);
  } catch {
    throw new Error("SCRAPE_BODY.url must be an absolute HTTP(S) URL");
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error("SCRAPE_BODY.url must be HTTP(S) and contain no credentials or fragment");
  }
  return body.url;
}

// ---------------------------------------------------------------------------
// [5] Write on-chain reputation — the ONLY signing/write site (besides the x402 payment)
// ---------------------------------------------------------------------------

interface FeedbackInput {
  agentId: number;
  value: number; // 0..100 integer (valueDecimals = 0)
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackUri: string;
}

export interface FeedbackOnchainExpectation {
  contractId: string;
  caller: string;
  agentId: number;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackUri: string;
  feedbackHash: string;
  submittedAtMs: number;
  networkPassphrase: string;
}

export interface FeedbackOnchainProof {
  ledger: number;
  confirmedAt: string;
  feedbackIndex: string;
  transactionXdr: string;
  eventXdr: string;
}

export interface FeedbackTransactionLike {
  sign(): Promise<void>;
  signed?: { hash(): Uint8Array; toXDR(): string };
  send(): Promise<{
    sendTransactionResponse?: { hash?: string };
    getTransactionResponse?: { status?: string; txHash?: string };
  }>;
}

export interface FeedbackSubmissionDependencies {
  /** Unit-test seam; production always uses the fsync-backed appendRunJournal. */
  appendJournal?: RunJournalAppender;
  nowMs?: () => number;
  /** Unit-test seam; production uses FEEDBACK_SEND_TIMEOUT_MS. */
  sendTimeoutMs?: number;
  /** Required fresh-RPC verification after the SDK reports terminal SUCCESS. */
  verifyFinalized(
    feedbackTxHash: string,
    signedTransactionXdr: string,
    submittedAtMs: number,
  ): Promise<FeedbackOnchainProof>;
}

export interface FeedbackSubmission {
  feedbackTxHash: string;
  onchain: FeedbackOnchainProof;
  journalPath: string;
}

function bytesToHex(value: unknown, label: string): string {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} is not bytes`);
  return Buffer.from(value).toString("hex");
}

function nativeField(value: unknown, field: string): unknown {
  if (value instanceof Map) return value.get(field);
  return isRecord(value) ? value[field] : undefined;
}

/** Independently bind a finalized transaction and NewFeedback event to the intended write. */
export function assertOnchainFeedback(
  transaction: unknown,
  txHash: string,
  signedTransactionXdr: string,
  expected: FeedbackOnchainExpectation,
): FeedbackOnchainProof {
  if (!isRecord(transaction) || transaction.status !== "SUCCESS") {
    throw new Error(`feedback transaction is not final-success (status=${String((transaction as any)?.status)})`);
  }
  const expectedTxHash = assertTransactionHash("signed feedback transaction hash", txHash);
  if (assertTransactionHash("feedback RPC transaction hash", transaction.txHash) !== expectedTxHash) {
    throw new Error("feedback RPC transaction hash does not match the signed transaction");
  }
  if (!Number.isSafeInteger(transaction.ledger) || transaction.ledger <= 0) {
    throw new Error("feedback transaction has no valid ledger sequence");
  }
  if (!Number.isFinite(transaction.createdAt)) {
    throw new Error("feedback transaction has no valid close time");
  }
  if (transaction.createdAt < Math.floor(expected.submittedAtMs / 1_000)) {
    throw new Error("feedback transaction predates this submission");
  }
  if (!(transaction.envelopeXdr instanceof xdr.TransactionEnvelope)) {
    throw new Error("feedback transaction has no parsed envelope XDR");
  }
  if (transactionEnvelopeHash(transaction.envelopeXdr, expected.networkPassphrase) !== expectedTxHash) {
    throw new Error("feedback finalized envelope hash does not match the signed transaction hash");
  }
  const finalTransactionXdr = transaction.envelopeXdr.toXDR("base64");
  if (finalTransactionXdr !== signedTransactionXdr) {
    throw new Error("feedback finalized envelope does not equal the durably journaled signed XDR");
  }

  const parsed = TransactionBuilder.fromXDR(transaction.envelopeXdr, expected.networkPassphrase);
  const inner = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
  if (inner.operations.length !== 1 || inner.operations[0]?.type !== "invokeHostFunction") {
    throw new Error("feedback transaction must contain exactly one invokeHostFunction operation");
  }
  const operation = inner.operations[0];
  if (operation.func.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new Error("feedback transaction must invoke a contract function");
  }
  const invocation = operation.func.invokeContract();
  const invokedContract = Address.fromScAddress(invocation.contractAddress()).toString();
  const invokedMethod = invocation.functionName().toString();
  const args = invocation.args().map((arg) => scValToNative(arg));
  if (
    invokedContract !== expected.contractId ||
    invokedMethod !== "give_feedback" ||
    args.length !== 9 ||
    String(args[0]) !== expected.caller ||
    Number(args[1]) !== expected.agentId ||
    BigInt(args[2] as bigint | number | string) !== expected.value ||
    Number(args[3]) !== expected.valueDecimals ||
    String(args[4]) !== expected.tag1 ||
    String(args[5]) !== expected.tag2 ||
    String(args[6]) !== expected.endpoint ||
    String(args[7]) !== expected.feedbackUri ||
    bytesToHex(args[8], "give_feedback feedback_hash") !== expected.feedbackHash
  ) {
    throw new Error("finalized give_feedback invocation does not match the intended full argument tuple");
  }

  const groups = transaction.events?.contractEventsXdr;
  if (!Array.isArray(groups)) throw new Error("feedback transaction has no parsed contract events");
  const matches: Array<{ feedbackIndex: bigint; eventXdr: string }> = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const event of group) {
      try {
        if (event.type().name !== "contract") continue;
        const contractId = event.contractId();
        if (
          !contractId ||
          Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractId)).toString() !==
            expected.contractId
        ) {
          continue;
        }
        const body = event.body().v0();
        const topics = body.topics();
        if (
          topics.length !== 4 ||
          topics[0].switch().name !== "scvSymbol" ||
          topics[0].sym().toString() !== "new_feedback"
        ) {
          continue;
        }
        const data = scValToNative(body.data());
        const feedbackIndex = BigInt(nativeField(data, "feedback_index") as bigint | number | string);
        if (
          Number(scValToNative(topics[1])) !== expected.agentId ||
          String(scValToNative(topics[2])) !== expected.caller ||
          String(scValToNative(topics[3])) !== expected.tag1 ||
          feedbackIndex <= 0n ||
          BigInt(nativeField(data, "value") as bigint | number | string) !== expected.value ||
          Number(nativeField(data, "value_decimals")) !== expected.valueDecimals ||
          String(nativeField(data, "tag2")) !== expected.tag2 ||
          String(nativeField(data, "endpoint")) !== expected.endpoint ||
          String(nativeField(data, "feedback_uri")) !== expected.feedbackUri ||
          bytesToHex(nativeField(data, "feedback_hash"), "NewFeedback feedback_hash") !==
            expected.feedbackHash
        ) {
          throw new Error("NewFeedback event does not match the intended full argument tuple");
        }
        matches.push({ feedbackIndex, eventXdr: event.toXDR("base64") });
      } catch (error) {
        throw new Error(
          `could not verify finalized NewFeedback event: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(`expected exactly one matching finalized NewFeedback event; got ${matches.length}`);
  }
  return {
    ledger: transaction.ledger,
    confirmedAt: new Date(transaction.createdAt * 1_000).toISOString(),
    feedbackIndex: matches[0].feedbackIndex.toString(),
    transactionXdr: finalTransactionXdr,
    eventXdr: matches[0].eventXdr,
  };
}

async function verifyFeedbackOnchain(
  cfg: DemoConfig,
  txHash: string,
  signedTransactionXdr: string,
  expected: FeedbackOnchainExpectation,
): Promise<FeedbackOnchainProof> {
  const server = new rpc.Server(cfg.rpcUrl, { allowHttp: false });
  return withStageDeadline("feedback RPC verification", FEEDBACK_RPC_TIMEOUT_MS, async () => {
    let transaction: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      transaction = await server.getTransaction(txHash);
      if (isRecord(transaction) && transaction.status !== "NOT_FOUND") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    return assertOnchainFeedback(transaction, txHash, signedTransactionXdr, expected);
  });
}

/**
 * Sign first, durably record the canonical signed transaction hash, then send
 * exactly once and require an RPC terminal SUCCESS before confirming it. There
 * is intentionally no signing or network implementation in this helper, which
 * keeps failed/unknown state transitions unit-testable.
 */
export async function submitFeedbackTransaction(
  transaction: FeedbackTransactionLike,
  startedAt: string,
  agentId: number,
  dependencies: FeedbackSubmissionDependencies,
): Promise<FeedbackSubmission> {
  const appendJournal = dependencies.appendJournal ?? appendRunJournal;
  const nowMs = dependencies.nowMs ?? Date.now;

  await transaction.sign();
  const signed = transaction.signed;
  if (!signed) throw new Error("feedback signing completed without a signed transaction; refusing to submit");
  const signedTransactionXdr = signed.toXDR();
  if (typeof signedTransactionXdr !== "string" || signedTransactionXdr.length === 0) {
    throw new Error("feedback signing completed without serializable transaction XDR; refusing to submit");
  }
  const feedbackTxHash = assertTransactionHash(
    "signed give_feedback transaction",
    Buffer.from(signed.hash()).toString("hex"),
  );
  const submittedAtMs = nowMs();

  let journalPath: string;
  try {
    journalPath = await appendJournal(startedAt, {
      event: "feedback_submitted",
      recordedAt: new Date(submittedAtMs).toISOString(),
      agentId,
      feedbackTxHash,
      signedTransactionXdrSha256: sha256Hex(signedTransactionXdr),
    });
  } catch (error) {
    throw new Error(
      `feedback journal could not be durably created; refusing to submit ${feedbackTxHash}: ${redactSensitiveError(error)}`,
    );
  }

  const outcomeUnknown = async (stage: string, cause: unknown): Promise<never> => {
    const markerFailure = await appendRecoveryMarker(appendJournal, startedAt, {
      event: "feedback_outcome_unknown",
      recordedAt: new Date(nowMs()).toISOString(),
      stage,
      feedbackTxHash,
    });
    throw new Error(
      `FEEDBACK_OUTCOME_UNKNOWN: tx=${feedbackTxHash}; recover from ${journalPath} and reconcile that exact hash. ` +
        `DO NOT submit another feedback until reconciliation.` +
        `${markerFailure ? ` Recovery marker also failed: ${markerFailure}.` : ""} ` +
        `Cause: ${redactSensitiveError(cause)}`,
    );
  };

  let sent: Awaited<ReturnType<FeedbackTransactionLike["send"]>>;
  try {
    sent = await withStageDeadline(
      "feedback send/finality",
      dependencies.sendTimeoutMs ?? FEEDBACK_SEND_TIMEOUT_MS,
      () => transaction.send(),
    );
  } catch (error) {
    return outcomeUnknown("send_or_poll", error);
  }

  try {
    for (const [label, candidate] of [
      ["sendTransaction hash", sent.sendTransactionResponse?.hash],
      ["getTransaction hash", sent.getTransactionResponse?.txHash],
    ] as const) {
      if (assertTransactionHash(label, candidate) !== feedbackTxHash) {
        throw new Error(`${label} does not match the durably journaled signed transaction`);
      }
    }
  } catch (error) {
    return outcomeUnknown("response_integrity", error);
  }

  const finalStatus = sent.getTransactionResponse?.status;
  if (finalStatus === "FAILED") {
    let journalFailure: string | null = null;
    try {
      await appendJournal(startedAt, {
        event: "feedback_failed",
        recordedAt: new Date(nowMs()).toISOString(),
        agentId,
        feedbackTxHash,
      });
    } catch (error) {
      journalFailure = redactSensitiveError(error);
    }
    throw new Error(
      `FEEDBACK_FAILED: tx=${feedbackTxHash} reached terminal FAILED; no feedback was confirmed and no ` +
        `acceptance receipt may be written. Recover from ${journalPath}; any new feedback requires explicit review.` +
        `${journalFailure ? ` Failure marker also failed: ${journalFailure}.` : ""}`,
    );
  }
  if (finalStatus !== "SUCCESS") {
    return outcomeUnknown("final_status", new Error(`expected SUCCESS, got ${String(finalStatus ?? "missing")}`));
  }

  let onchain: FeedbackOnchainProof;
  try {
    onchain = await dependencies.verifyFinalized(
      feedbackTxHash,
      signedTransactionXdr,
      submittedAtMs,
    );
  } catch (error) {
    return outcomeUnknown("independent_rpc_verification", error);
  }

  try {
    await appendJournal(startedAt, {
      event: "feedback_confirmed",
      recordedAt: new Date(nowMs()).toISOString(),
      agentId,
      feedbackTxHash,
      feedbackIndex: onchain.feedbackIndex,
      feedbackLedger: onchain.ledger,
      feedbackConfirmedAt: onchain.confirmedAt,
      feedbackTransactionXdr: onchain.transactionXdr,
      feedbackEventXdr: onchain.eventXdr,
    });
  } catch (error) {
    throw new Error(
      `FEEDBACK_SUBMITTED: tx=${feedbackTxHash} reached SUCCESS, but ${journalPath} could not be finalized. ` +
        `Recover using that exact hash; DO NOT submit another feedback. Cause: ${redactSensitiveError(error)}`,
    );
  }

  return { feedbackTxHash, onchain, journalPath };
}

async function writeFeedback(
  cfg: DemoConfig,
  p: FeedbackInput,
  startedAt: string,
): Promise<FeedbackSubmission> {
  const secret = process.env.STELLAR_PRIVATE_KEY;
  if (!secret) throw new Error("STELLAR_PRIVATE_KEY required to sign give_feedback");
  const kp = Keypair.fromSecret(secret);

  const signer = wrapBasicSigner(kp, cfg.stellar.networkPassphrase);
  const { reputation } = createClients(cfg.stellar, signer);

  const feedbackHash = createHash("sha256").update(p.feedbackUri).digest(); // 32-byte Buffer

  const tx = await withStageDeadline(
    "feedback transaction assembly",
    FEEDBACK_ASSEMBLY_TIMEOUT_MS,
    () =>
      reputation.give_feedback({
        caller: kp.publicKey(),
        agent_id: p.agentId,
        value: BigInt(p.value),
        value_decimals: 0,
        tag1: p.tag1,
        tag2: p.tag2,
        endpoint: p.endpoint,
        feedback_uri: p.feedbackUri,
        feedback_hash: feedbackHash,
      }),
  );

  return submitFeedbackTransaction(tx, startedAt, p.agentId, {
    verifyFinalized: (feedbackTxHash, signedTransactionXdr, submittedAtMs) =>
      verifyFeedbackOnchain(cfg, feedbackTxHash, signedTransactionXdr, {
        contractId: cfg.stellar.contracts.reputation,
        caller: kp.publicKey(),
        agentId: p.agentId,
        value: BigInt(p.value),
        valueDecimals: 0,
        tag1: p.tag1,
        tag2: p.tag2,
        endpoint: p.endpoint,
        feedbackUri: p.feedbackUri,
        feedbackHash: feedbackHash.toString("hex"),
        submittedAtMs,
        networkPassphrase: cfg.stellar.networkPassphrase,
      }),
  });
}

// ---------------------------------------------------------------------------
// [6] Evidence
// ---------------------------------------------------------------------------

function expertTxLink(cfg: DemoConfig, hash: string): string {
  const net = cfg.network === "mainnet" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${net}/tx/${hash}`;
}

function expertContractLink(cfg: DemoConfig, contract: string): string {
  const net = cfg.network === "mainnet" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${net}/contract/${contract}`;
}

export interface RunRecord {
  network: NetworkLabel;
  dryRun: boolean;
  payerPublicKey: string | null;
  agentId: number;
  owner: string | null;
  endpoint: string;
  canonicalEndpoint: string;
  requestMethod: string;
  requestBodySha256: string;
  requestDigest: string;
  idempotencyKey: string;
  challengeNetwork: string;
  asset: string;
  payTo: string;
  price: string;
  paymentTxHash: string;
  paymentAuthorizationHash: string;
  paymentTransactionXdrSha256: string;
  signedPaymentPayloadSha256: string;
  paymentResponseHeaderBytes: number;
  paymentResponseHeaderSha256: string;
  settlementRecomputedTxHash: string;
  settlementTransactionXdr: string;
  settlementLedger: number;
  settlementConfirmedAt: string;
  resultHash: string;
  resultOk: boolean | null;
  feedbackTxHash: string;
  feedbackIndex: string;
  feedbackLedger: number;
  feedbackConfirmedAt: string;
  feedbackTransactionXdr: string;
  feedbackEventXdr: string;
  startedAt: string;
  finishedAt: string;
  expertLinks: Record<string, string>;
}

/** Defense-in-depth: a non-dry-run file is an acceptance receipt, so it must be complete. */
export function assertCompleteEvidenceRecord(rec: RunRecord): void {
  if (rec.dryRun) return;
  if (rec.network !== "mainnet") throw new Error("evidence receipt must be mainnet");
  if (rec.agentId !== SCRAPPER_AGENT_ID) throw new Error(`evidence receipt agent must be ${SCRAPPER_AGENT_ID}`);
  if (rec.owner !== SCRAPPER_OWNER) throw new Error("evidence receipt owner does not match pinned Scrapper owner");
  if (!(SCRAPPER_ALLOWED_ENDPOINTS as readonly string[]).includes(rec.endpoint)) {
    throw new Error("evidence receipt endpoint is not allowlisted");
  }
  if (rec.canonicalEndpoint !== new URL(rec.endpoint).toString() || rec.requestMethod !== "POST") {
    throw new Error("evidence receipt canonical request endpoint/method is invalid");
  }
  assertResultHash(rec.requestBodySha256);
  assertResultHash(rec.requestDigest);
  assertResultHash(rec.idempotencyKey);
  if (rec.challengeNetwork !== STELLAR_PUBNET_CAIP2) throw new Error("evidence receipt challenge is not pubnet");
  if (rec.asset !== USDC_CONTRACT_MAINNET) throw new Error("evidence receipt asset is not mainnet USDC");
  if (rec.payTo !== SCRAPPER_EXPECTED_PAY_TO) throw new Error("evidence receipt payTo does not match pinned payee");
  const payer = assertPublicKey("evidence payerPublicKey", rec.payerPublicKey);
  if (payer === rec.owner || payer === rec.payTo) throw new Error("evidence payer must differ from owner/payTo");
  const expectedRequestDigest = sha256Hex(
    JSON.stringify({
      canonicalEndpoint: rec.canonicalEndpoint,
      requestMethod: rec.requestMethod,
      requestBodySha256: rec.requestBodySha256,
    }),
  );
  if (
    rec.requestDigest !== expectedRequestDigest ||
    rec.idempotencyKey !== sha256Hex(`${payer}\n${rec.agentId}\n${expectedRequestDigest}`)
  ) {
    throw new Error("evidence receipt canonical request identity is inconsistent");
  }
  if (!/^\d+$/.test(rec.price) || BigInt(rec.price) <= 0n) throw new Error("evidence receipt price is invalid");
  const paymentTxHash = assertTransactionHash("evidence paymentTxHash", rec.paymentTxHash);
  assertResultHash(rec.paymentAuthorizationHash);
  assertResultHash(rec.paymentTransactionXdrSha256);
  assertResultHash(rec.signedPaymentPayloadSha256);
  assertResultHash(rec.paymentResponseHeaderSha256);
  if (
    !Number.isSafeInteger(rec.paymentResponseHeaderBytes) ||
    rec.paymentResponseHeaderBytes <= 0 ||
    rec.paymentResponseHeaderBytes > MAX_SETTLEMENT_HEADER_BYTES
  ) {
    throw new Error("evidence receipt PAYMENT-RESPONSE header length is invalid");
  }
  const recordedRecomputedHash = assertTransactionHash(
    "evidence settlementRecomputedTxHash",
    rec.settlementRecomputedTxHash,
  );
  let envelopeRecomputedHash: string;
  try {
    envelopeRecomputedHash = transactionEnvelopeHash(
      rec.settlementTransactionXdr,
      MAINNET_CONFIG.networkPassphrase,
    );
  } catch {
    throw new Error("evidence receipt settlement envelope XDR is invalid");
  }
  if (recordedRecomputedHash !== paymentTxHash || envelopeRecomputedHash !== paymentTxHash) {
    throw new Error("evidence receipt settlement XDR/hash binding is invalid");
  }
  if (!Number.isSafeInteger(rec.settlementLedger) || rec.settlementLedger <= 0) {
    throw new Error("evidence receipt settlement ledger is invalid");
  }
  if (!Number.isFinite(Date.parse(rec.settlementConfirmedAt))) {
    throw new Error("evidence receipt settlement confirmation time is invalid");
  }
  assertResultHash(rec.resultHash);
  if (rec.resultOk !== true) throw new Error("paid result was not usable; refusing to label the run as acceptance evidence");
  const feedbackTxHash = assertTransactionHash("evidence feedbackTxHash", rec.feedbackTxHash);
  if (paymentTxHash === feedbackTxHash) throw new Error("payment and feedback must be two distinct transactions");
  if (!/^\d+$/.test(rec.feedbackIndex) || BigInt(rec.feedbackIndex) <= 0n) {
    throw new Error("evidence receipt feedback index is invalid");
  }
  if (!Number.isSafeInteger(rec.feedbackLedger) || rec.feedbackLedger <= 0) {
    throw new Error("evidence receipt feedback ledger is invalid");
  }
  if (!Number.isFinite(Date.parse(rec.feedbackConfirmedAt))) {
    throw new Error("evidence receipt feedback confirmation time is invalid");
  }
  try {
    if (
      transactionEnvelopeHash(rec.feedbackTransactionXdr, MAINNET_CONFIG.networkPassphrase) !==
      feedbackTxHash
    ) {
      throw new Error("hash mismatch");
    }
    xdr.ContractEvent.fromXDR(rec.feedbackEventXdr, "base64");
  } catch {
    throw new Error("evidence receipt feedback envelope/event XDR binding is invalid");
  }
}

export type RunJournalEntry =
  | {
      event: "payment_submission_prepared";
      recordedAt: string;
      payerPublicKey: string;
      agentId: number;
      endpoint: string;
      challengeNetwork: string;
      asset: string;
      payTo: string;
      price: string;
      paymentAuthorizationHash: string;
      canonicalEndpoint: string;
      requestMethod: string;
      requestBodySha256: string;
      requestDigest: string;
      idempotencyKey: string;
      paymentTransactionXdrSha256: string;
      signedPaymentPayloadSha256: string;
      paymentRecoveryArtifactPath: string;
      paymentRecoveryArtifactSha256: string;
    }
  | {
      event: "payment_response_received";
      recordedAt: string;
      httpStatus: number;
    }
  | {
      event: "payment_outcome_unknown";
      recordedAt: string;
      stage: string;
      httpStatus?: number;
      settlementStatus: "unknown" | "confirmed";
      paymentTxHash?: string;
    }
  | {
      event: "settlement_claim_received";
      recordedAt: string;
      httpStatus: number;
      headerPresent: boolean;
      decoded: boolean;
      claimSuccess: boolean;
      networkMatches: boolean;
      payerMatches: boolean;
      paymentTxHash: string | null;
      paymentResponseHeaderBytes: number;
      paymentResponseHeaderSha256: string | null;
      claimedNetwork: string | null;
      claimedPayer: string | null;
      claimedAmount: string | null;
    }
  | {
      event: "settlement_confirmed";
      recordedAt: string;
      paymentTxHash: string;
      settlementRecomputedTxHash: string;
      settlementLedger: number;
      settlementConfirmedAt: string;
      settlementTransactionXdr: string;
    }
  | {
      event: "result_hashed";
      recordedAt: string;
      resultHash: string;
      resultOk: boolean;
    }
  | {
      event: "feedback_submitted";
      recordedAt: string;
      agentId: number;
      feedbackTxHash: string;
      signedTransactionXdrSha256: string;
    }
  | {
      event: "feedback_failed";
      recordedAt: string;
      agentId: number;
      feedbackTxHash: string;
    }
  | {
      event: "feedback_outcome_unknown";
      recordedAt: string;
      stage: string;
      feedbackTxHash: string;
    }
  | {
      event: "feedback_confirmed";
      recordedAt: string;
      agentId: number;
      feedbackTxHash: string;
      feedbackIndex: string;
      feedbackLedger: number;
      feedbackConfirmedAt: string;
      feedbackTransactionXdr: string;
      feedbackEventXdr: string;
    }
  | {
      event: "funded_lock_released";
      recordedAt: string;
      release: "known_terminal" | "reviewed_reconciliation";
      reason: string;
      idempotencyKey: string;
      previousState: "locked" | "payment_submission_prepared";
    };

function filesystemErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

/** Sync the containing directory so create/rename/unlink survives a crash. */
export async function fsyncParentDirectory(path: string): Promise<void> {
  const handle = await open(dirname(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Append one JSONL record with file and directory durability and private mode. */
export async function appendDurableJsonLine(out: string, entry: unknown): Promise<string> {
  const line = `${JSON.stringify(entry)}\n`;
  let created = false;
  let handle;
  try {
    handle = await open(out, "ax", 0o600);
    created = true;
  } catch (error) {
    if (filesystemErrorCode(error) !== "EEXIST") throw error;
    handle = await open(out, "a", 0o600);
  }
  try {
    await handle.chmod(0o600);
    await handle.appendFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (created) await fsyncParentDirectory(out);
  return out;
}

function serializeJsonFile(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new Error("value is not JSON serializable");
  return serialized;
}

/** Atomically replace a JSON file only after its complete bytes are durable. */
export async function writeAtomicJsonFile(out: string, value: unknown): Promise<string> {
  const serialized = serializeJsonFile(value);
  const temporary = `${out}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, out);
    await fsyncParentDirectory(out);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return out;
}

/**
 * Persist the exact signed payment material privately before any signed HTTP
 * byte can leave the process. The random suffix prevents a prior artifact from
 * being silently replaced; its path and exact-byte digest are then bound into
 * both journal and funded-run lock.
 */
export async function writePaymentRecoveryArtifact(
  startedAt: string,
  artifact: PaymentRecoveryArtifact,
  directory = HERE,
): Promise<PaymentRecoveryArtifactReference> {
  const idempotencyKey = assertResultHash(artifact.idempotencyKey);
  assertResultHash(artifact.paymentAuthorizationHash);
  if (
    artifact.kind !== "x402_signed_payment_recovery" ||
    artifact.version !== 1 ||
    typeof artifact.paymentTransactionXdr !== "string" ||
    artifact.paymentTransactionXdr.length === 0 ||
    typeof artifact.signedPaymentPayloadJson !== "string" ||
    artifact.signedPaymentPayloadJson.length === 0
  ) {
    throw new Error("payment recovery artifact is incomplete");
  }
  const timestamp = startedAt.replace(/[:.]/g, "-");
  const out = resolve(
    directory,
    `run-${timestamp}-${idempotencyKey.slice(0, 16)}-${randomUUID()}.payment-recovery.json`,
  );
  const expectedSha256 = sha256Hex(serializeJsonFile(artifact));
  await writeAtomicJsonFile(out, artifact);
  const actualSha256 = sha256Hex(await readFile(out));
  if (actualSha256 !== expectedSha256) {
    throw new Error("payment recovery artifact failed post-write digest verification");
  }
  return { path: out, sha256: actualSha256 };
}

/** Append-only crash-recovery trail; contains hashes and public chain facts only. */
async function appendRunJournal(startedAt: string, entry: RunJournalEntry): Promise<string> {
  const out = resolve(HERE, `run-${startedAt.replace(/[:.]/g, "-")}.journal.jsonl`);
  return appendDurableJsonLine(out, entry);
}

async function recordEvidence(cfg: DemoConfig, rec: RunRecord): Promise<string> {
  assertCompleteEvidenceRecord(rec);
  const out = resolve(HERE, `run-${rec.startedAt.replace(/[:.]/g, "-")}.json`);
  return writeAtomicJsonFile(out, rec);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();
  const startedAt = new Date().toISOString();
  console.log(`\n=== x402 agent-finds-agent loop (${cfg.network}${cfg.dryRun ? ", DRY-RUN" : ""}) ===`);
  console.log(`payer=${cfg.payerPublicKey ?? "(no key — dry-run discovery only)"}`);

  // [1] Preflight — fail fast before any spend (advisory in dry-run).
  await runPreflight(cfg);

  // [2] Discover the scrapper via OUR read-only, keyless MCP server.
  const agent = await discoverScrapper(cfg);
  console.log(
    `[discover] agentId=${agent.agentId} x402=${agent.x402Enabled} endpoint=${agent.endpoint}` +
      ` owner=${agent.owner ?? "?"} wallet=${agent.wallet ?? "(empty — payTo from 402)"}`,
  );
  // Discovery is part of the proof. A missing/error result, a non-x402 profile,
  // or a changed identity/endpoint is fatal even in dry-run; there is no fallback.
  assertEvidenceTarget(cfg, agent);
  if (cfg.payerPublicKey && (cfg.payerPublicKey === agent.owner || cfg.payerPublicKey === agent.wallet)) {
    throw new Error("payer == agent owner/wallet → give_feedback would revert SelfFeedback; use a different key");
  }

  if (cfg.dryRun) {
    console.log("\n[dry-run] preflight + discovery complete; skipping payment + feedback (no spend).");
    const out = await recordEvidence(cfg, {
      network: cfg.network,
      dryRun: true,
      payerPublicKey: cfg.payerPublicKey,
      agentId: agent.agentId,
      owner: agent.owner,
      endpoint: agent.endpoint,
      canonicalEndpoint: "",
      requestMethod: "",
      requestBodySha256: "",
      requestDigest: "",
      idempotencyKey: "",
      challengeNetwork: "",
      asset: "",
      payTo: "",
      price: "",
      paymentTxHash: "",
      paymentAuthorizationHash: "",
      paymentTransactionXdrSha256: "",
      signedPaymentPayloadSha256: "",
      paymentResponseHeaderBytes: 0,
      paymentResponseHeaderSha256: "",
      settlementRecomputedTxHash: "",
      settlementTransactionXdr: "",
      settlementLedger: 0,
      settlementConfirmedAt: "",
      resultHash: "",
      resultOk: null,
      feedbackTxHash: "",
      feedbackIndex: "",
      feedbackLedger: 0,
      feedbackConfirmedAt: "",
      feedbackTransactionXdr: "",
      feedbackEventXdr: "",
      startedAt,
      finishedAt: new Date().toISOString(),
      expertLinks: {
        reputationContract: expertContractLink(cfg, REPUTATION_CONTRACT_MAINNET),
        usdcContract: expertContractLink(cfg, USDC_CONTRACT_MAINNET),
      },
    });
    console.log(`[dry-run] wrote ${out}`);
    return;
  }

  // [3/4] Pin the exact request/result contract before spending, then pay via
  // x402 and receive the scraped result (real mainnet USDC).
  const scrapeUrl = expectedScrapeUrl(cfg);
  const requestIdentity = canonicalRequestIdentity(
    cfg,
    assertPublicKey("payer", cfg.payerPublicKey),
    agent.agentId,
    agent.endpoint,
  );
  const fundedLock = await acquireFundedRunLock(requestIdentity, startedAt);
  console.log(`[pay] exclusive replay lock: ${fundedLock.path}`);
  const {
    resultHash,
    resultOk,
    paymentTxHash,
    paymentAuthorizationHash,
    payTo,
    price,
    asset,
    challengeNetwork,
    settlementLedger,
    settlementConfirmedAt,
    settlementRecomputedTxHash,
    journalPath,
    paymentTransactionXdrSha256,
    signedPaymentPayloadSha256,
    paymentResponseHeaderBytes,
    paymentResponseHeaderSha256,
    settlementTransactionXdr,
  } = await payForService(
    cfg,
    agent,
    startedAt,
    scrapeUrl,
    requestIdentity,
    (submission) => fundedLock.markPaymentSubmissionPrepared(submission),
  );
  console.log(`[pay] settled. payTo=${payTo} price=${price} paymentTx=${paymentTxHash}`);

  // [5] Write on-chain reputation. The score reflects the ACTUAL outcome — a 200
  // with a garbage/empty body must not earn a top score.
  console.log(`[result] sha256=${resultHash} schemaAccepted=${resultOk}`);
  const value = resultOk ? 95 : 40;
  if (!resultOk) {
    process.stderr.write(
      "[feedback] warning: paid result did not look like a valid scrape — recording a below-expectation score, not 95\n",
    );
  }
  console.log(`[evidence] provisional payment journal: ${journalPath}`);

  const evidenceUri = `data:application/json;base64,${Buffer.from(
    JSON.stringify({
      agentId: agent.agentId,
      owner: agent.owner,
      endpoint: agent.endpoint,
      challengeNetwork,
      asset,
      payTo,
      price,
      paymentTxHash,
      paymentAuthorizationHash,
      settlementLedger,
      settlementConfirmedAt,
      resultHash,
      resultOk,
      ts: startedAt,
    }),
  ).toString("base64")}`;
  let feedbackSubmission: FeedbackSubmission;
  try {
    feedbackSubmission = await writeFeedback(
      cfg,
      {
        agentId: agent.agentId,
        value,
        tag1: resultOk ? "starred" : "belowExpectation",
        tag2: "successRate",
        endpoint: agent.endpoint,
        feedbackUri: evidenceUri,
      },
      startedAt,
    );
  } catch (error) {
    throw new Error(
      `PAYMENT_ALREADY_SETTLED: feedback failed. Resume from ${journalPath}; DO NOT rerun payment. ` +
        `Cause: ${redactSensitiveError(error)}`,
    );
  }
  const { feedbackTxHash, onchain: feedbackOnchain } = feedbackSubmission;
  console.log(`[feedback] on-chain. feedbackTx=${feedbackTxHash}`);

  if (!resultOk) {
    process.stderr.write(
      `[evidence] payment and below-expectation feedback are journaled at ${journalPath}; ` +
        "no acceptance receipt will be written\n",
    );
    return;
  }

  const receipt: RunRecord = {
    network: cfg.network,
    dryRun: false,
    payerPublicKey: cfg.payerPublicKey,
    agentId: agent.agentId,
    owner: agent.owner,
    endpoint: agent.endpoint,
    canonicalEndpoint: requestIdentity.canonicalEndpoint,
    requestMethod: requestIdentity.requestMethod,
    requestBodySha256: requestIdentity.requestBodySha256,
    requestDigest: requestIdentity.requestDigest,
    idempotencyKey: requestIdentity.idempotencyKey,
    challengeNetwork,
    asset,
    payTo,
    price,
    paymentTxHash,
    paymentAuthorizationHash,
    paymentTransactionXdrSha256,
    signedPaymentPayloadSha256,
    paymentResponseHeaderBytes,
    paymentResponseHeaderSha256,
    settlementRecomputedTxHash,
    settlementTransactionXdr,
    settlementLedger,
    settlementConfirmedAt,
    resultHash,
    resultOk,
    feedbackTxHash,
    feedbackIndex: feedbackOnchain.feedbackIndex,
    feedbackLedger: feedbackOnchain.ledger,
    feedbackConfirmedAt: feedbackOnchain.confirmedAt,
    feedbackTransactionXdr: feedbackOnchain.transactionXdr,
    feedbackEventXdr: feedbackOnchain.eventXdr,
    startedAt,
    finishedAt: new Date().toISOString(),
    expertLinks: {
      payment: expertTxLink(cfg, paymentTxHash),
      feedback: expertTxLink(cfg, feedbackTxHash),
      reputationContract: expertContractLink(cfg, REPUTATION_CONTRACT_MAINNET),
      usdcContract: expertContractLink(cfg, USDC_CONTRACT_MAINNET),
    },
  };
  // Receipt validation and persistence are one post-settlement recovery
  // boundary. Either failure must point to the pre-submit journal and must not
  // tempt an operator into replaying either transaction.
  let out: string;
  try {
    assertCompleteEvidenceRecord(receipt);
    out = await recordEvidence(cfg, receipt);
  } catch (error) {
    throw new Error(
      `PAYMENT_AND_FEEDBACK_SETTLED: final receipt failed; recover from ${journalPath}. ` +
        `DO NOT rerun either transaction. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // [6] Evidence — two mainnet tx hashes + Stellar Expert links + run.json.
  // Do not print the acceptance banner until the complete receipt is durable.
  console.log(`\n=== EVIDENCE (${cfg.network}) ===`);
  console.log(`payment  tx: ${paymentTxHash}\n             ${expertTxLink(cfg, paymentTxHash)}`);
  console.log(`result sha256: ${resultHash}`);
  console.log(`feedback tx: ${feedbackTxHash}\n             ${expertTxLink(cfg, feedbackTxHash)}`);
  console.log(`\n[evidence] wrote ${out}`);
}

const invokedDirectly = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const runDirectCli = async (): Promise<void> => {
    const args = process.argv.slice(2);
    if (args[0] === "--release-reconciled-lock") {
      if (
        args.length !== 3 ||
        args[2] !== "--confirmed-ledger-reconciled" ||
        typeof args[1] !== "string"
      ) {
        throw new Error(
          "usage: x402-demo.ts --release-reconciled-lock <idempotency-key> --confirmed-ledger-reconciled",
        );
      }
      await releaseReconciledFundedRunLock(args[1]);
      console.log(
        `[recovery] released reconciled mutex for ${args[1]}; durable journal/artifact replay gates remain authoritative`,
      );
      return;
    }
    if (args.length !== 0) throw new Error(`unknown x402-demo argument: ${args[0]}`);

    // Tests and the recovery command must never hydrate a real .env key.
    loadDotenv({ path: resolve(HERE, ".env") });
    await main();
  };

  runDirectCli().catch((e) => {
    console.error("FATAL:", redactSensitiveError(e));
    process.exit(1);
  });
}
