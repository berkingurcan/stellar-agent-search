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
 *   [5] FEEDBACK    — write on-chain reputation via @trionlabs/stellar8004 give_feedback. THIS is the
 *                     ONLY place a private key / signing exists.
 *   [6] EVIDENCE    — print 2 mainnet tx hashes + Stellar Expert links; write run.json (NO secrets).
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

import { createHash } from "node:crypto";
import { dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
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
import type { PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";

import {
  createClients,
  wrapBasicSigner,
  MAINNET_CONFIG,
  TESTNET_CONFIG,
} from "@trionlabs/stellar8004";
import type { StellarConfig } from "@trionlabs/stellar8004";
import { Address, Keypair, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

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
        if (!(await rpcHealthy(cfg))) throw new Error(`RPC ${cfg.rpcUrl} not healthy`);
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
      const msg = err instanceof Error ? err.message : String(err);
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
  if (cfg.explorerBaseUrl) childEnv.EXPLORER_BASE_URL = cfg.explorerBaseUrl;
  if (process.env.STELLAR_RPC_URL) childEnv.STELLAR_RPC_URL = process.env.STELLAR_RPC_URL;
  // Forward NON-SECRET network/proxy/TLS config so the read-only server can still reach
  // the explorer + Soroban RPC behind a corporate or sandboxed HTTPS proxy. These are not
  // secrets; the secret assertion below still guarantees STELLAR_PRIVATE_KEY / X402_API_KEY
  // are NEVER placed in the child env.
  for (const k of [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
  ]) {
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
  result: unknown;
  resultHash: string;
  paymentTxHash: string;
  settlementLedger: number;
  settlementConfirmedAt: string;
  payTo: string;
  price: string;
  asset: string;
  challengeNetwork: string;
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

function scrapeInit(cfg: DemoConfig, extraHeaders?: Record<string, string>): RequestInit {
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  const init: RequestInit = { method: cfg.scrapeMethod, headers };
  if (cfg.scrapeMethod !== "GET" && cfg.scrapeMethod !== "HEAD" && cfg.scrapeBody != null) {
    headers["content-type"] = "application/json";
    init.body = cfg.scrapeBody;
  }
  return init;
}

async function payForService(cfg: DemoConfig, agent: ResolvedAgent): Promise<PayResult> {
  assertEvidenceTarget(cfg, agent);
  const { client, http } = buildX402(cfg);
  const url = agent.endpoint;

  // 1) First request — expect HTTP 402.
  const first = await fetch(url, scrapeInit(cfg));
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
  // would double-spend real USDC. Surface it for a human to inspect the ledger
  // and re-run manually instead of silently paying twice.
  const submittedAtMs = Date.now();
  const paid = await settleOnce(client, http, url, cfg, validated.required);
  if (paid.status === 402) {
    const retry = http.getPaymentRequiredResponse((name) => paid.headers.get(name));
    throw new Error(
      "payment not accepted (HTTP 402 after submitting payment). NOT retrying, to avoid a " +
        "double-spend: check whether a payment settled on-chain before re-running. " +
        `Challenge: ${JSON.stringify(retry)}`,
    );
  }
  if (!paid.ok) throw new Error(`service error after payment: ${paid.status}`);

  // 5) Treat PAYMENT-RESPONSE as an untrusted claim. Validate its full
  // SettleResponse tuple, then independently require a successful RPC transaction
  // containing exactly the expected USDC transfer before consuming the result or
  // writing reputation.
  const settlement = decodeSettlementResponse(paid.headers.get("PAYMENT-RESPONSE"));
  const paymentTxHash = validateSettlementResponse(settlement, {
    payer: assertPublicKey("payer", cfg.payerPublicKey),
    network: accept.network,
    amount: accept.amount,
  });
  const onchain = await verifySettlementOnchain(cfg, paymentTxHash, {
    payer: assertPublicKey("payer", cfg.payerPublicKey),
    payTo,
    asset: accept.asset,
    amount: accept.amount,
    submittedAtMs,
  });
  const { result, resultHash } = await readPaidResult(paid);
  return {
    result,
    resultHash,
    paymentTxHash,
    payTo,
    price,
    asset: accept.asset,
    challengeNetwork: accept.network,
    settlementLedger: onchain.ledger,
    settlementConfirmedAt: onchain.confirmedAt,
  };
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

async function settleOnce(
  client: x402Client,
  http: x402HTTPClient,
  url: string,
  cfg: DemoConfig,
  required: PaymentRequired,
): Promise<Response> {
  let payload;
  try {
    payload = await client.createPaymentPayload(required);
  } catch (err) {
    throw new Error(`payment creation failed (USDC/trustline/RPC?): ${err instanceof Error ? err.message : String(err)}`);
  }
  const paymentHeaders = http.encodePaymentSignatureHeader(payload);
  return fetch(url, scrapeInit(cfg, paymentHeaders));
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
    throw new Error(
      `x402 settlement reported failure: ${String((response as any)?.errorReason ?? "unknown")}`,
    );
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
}

interface OnchainSettlementProof {
  ledger: number;
  confirmedAt: string;
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
  if (assertTransactionHash("RPC transaction hash", transaction.txHash) !== txHash) {
    throw new Error("RPC transaction hash does not match PAYMENT-RESPONSE");
  }
  if (!Number.isSafeInteger(transaction.ledger) || transaction.ledger <= 0) {
    throw new Error("settlement transaction has no valid ledger sequence");
  }
  if (!Number.isFinite(transaction.createdAt)) {
    throw new Error("settlement transaction has no valid close time");
  }
  // SDK v15 exposes `createdAt` as Unix seconds. Reject a replay that predates
  // this one-shot submission (allow only sub-second representation rounding).
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
  };
}

async function verifySettlementOnchain(
  cfg: DemoConfig,
  txHash: string,
  expected: OnchainSettlementExpectation,
): Promise<OnchainSettlementProof> {
  const server = new rpc.Server(cfg.rpcUrl, { allowHttp: false });
  let transaction: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    transaction = await server.getTransaction(txHash);
    if (isRecord(transaction) && transaction.status !== "NOT_FOUND") break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  return assertOnchainSettlement(transaction, txHash, expected);
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

export async function readPaidResult(res: Response): Promise<{ result: unknown; resultHash: string }> {
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
  } finally {
    reader.releaseLock();
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
 * Did the paid call return a genuinely usable result, or a 200 with an empty /
 * garbage body? We must NOT write a top on-chain reputation score for a failed
 * outcome — that would corrupt the very signal this registry is about.
 */
export function isSuccessfulResult(result: unknown): boolean {
  if (result == null || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if (r.success === false || r.ok === false) return false;
  if ("error" in r && r.error != null && r.error !== "") return false;
  if (
    typeof r.status === "string" &&
    ["error", "failed", "failure", "rejected", "cancelled", "canceled"].includes(
      r.status.trim().toLowerCase(),
    )
  ) {
    return false;
  }
  const keys = Object.keys(r);
  // safeJson wraps a non-JSON body as { raw: "…" } — not a structured result.
  if (keys.length === 0 || (keys.length === 1 && keys[0] === "raw")) return false;
  // Require at least one non-empty field.
  return keys
    .filter((k) => !["success", "ok", "status", "message"].includes(k))
    .some((k) => {
      const v = r[k];
      if (v == null) return false;
      if (typeof v === "string") return v.trim().length > 0;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
      return true;
    });
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

async function writeFeedback(cfg: DemoConfig, p: FeedbackInput): Promise<string> {
  const secret = process.env.STELLAR_PRIVATE_KEY;
  if (!secret) throw new Error("STELLAR_PRIVATE_KEY required to sign give_feedback");
  const kp = Keypair.fromSecret(secret);

  const signer = wrapBasicSigner(kp, cfg.stellar.networkPassphrase);
  const { reputation } = createClients(cfg.stellar, signer);

  const feedbackHash = createHash("sha256").update(p.feedbackUri).digest(); // 32-byte Buffer

  const tx = await reputation.give_feedback({
    caller: kp.publicKey(),
    agent_id: p.agentId,
    value: BigInt(p.value),
    value_decimals: 0,
    tag1: p.tag1,
    tag2: p.tag2,
    endpoint: p.endpoint,
    feedback_uri: p.feedbackUri,
    feedback_hash: feedbackHash,
  });

  const sent = await tx.signAndSend(); // simulate → assemble → sign → send → poll
  const hash = sent.sendTransactionResponse?.hash;
  return assertTransactionHash("give_feedback transaction", hash);
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
  challengeNetwork: string;
  asset: string;
  payTo: string;
  price: string;
  paymentTxHash: string;
  settlementLedger: number;
  settlementConfirmedAt: string;
  resultHash: string;
  resultOk: boolean | null;
  feedbackTxHash: string;
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
  if (rec.challengeNetwork !== STELLAR_PUBNET_CAIP2) throw new Error("evidence receipt challenge is not pubnet");
  if (rec.asset !== USDC_CONTRACT_MAINNET) throw new Error("evidence receipt asset is not mainnet USDC");
  if (rec.payTo !== SCRAPPER_EXPECTED_PAY_TO) throw new Error("evidence receipt payTo does not match pinned payee");
  const payer = assertPublicKey("evidence payerPublicKey", rec.payerPublicKey);
  if (payer === rec.owner || payer === rec.payTo) throw new Error("evidence payer must differ from owner/payTo");
  if (!/^\d+$/.test(rec.price) || BigInt(rec.price) <= 0n) throw new Error("evidence receipt price is invalid");
  const paymentTxHash = assertTransactionHash("evidence paymentTxHash", rec.paymentTxHash);
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
}

async function recordEvidence(cfg: DemoConfig, rec: RunRecord): Promise<string> {
  assertCompleteEvidenceRecord(rec);
  const out = resolve(HERE, `run-${rec.startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(out, JSON.stringify(rec, null, 2), "utf8");
  return out;
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
      challengeNetwork: "",
      asset: "",
      payTo: "",
      price: "",
      paymentTxHash: "",
      settlementLedger: 0,
      settlementConfirmedAt: "",
      resultHash: "",
      resultOk: null,
      feedbackTxHash: "",
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

  // [3/4] Pay via x402 and receive the scraped result (real mainnet USDC).
  const {
    result,
    resultHash,
    paymentTxHash,
    payTo,
    price,
    asset,
    challengeNetwork,
    settlementLedger,
    settlementConfirmedAt,
  } = await payForService(cfg, agent);
  console.log(`[pay] settled. payTo=${payTo} price=${price} paymentTx=${paymentTxHash}`);
  console.log(`[result] sha256=${resultHash} ${JSON.stringify(result).slice(0, 240)}...`);

  // [5] Write on-chain reputation. The score reflects the ACTUAL outcome — a 200
  // with a garbage/empty body must not earn a top score.
  const resultOk = isSuccessfulResult(result);
  const value = resultOk ? 95 : 40;
  if (!resultOk) {
    process.stderr.write(
      "[feedback] warning: paid result did not look like a valid scrape — recording a below-expectation score, not 95\n",
    );
  }
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
      settlementLedger,
      settlementConfirmedAt,
      resultHash,
      resultOk,
      ts: startedAt,
    }),
  ).toString("base64")}`;
  const feedbackTxHash = await writeFeedback(cfg, {
    agentId: agent.agentId,
    value,
    tag1: resultOk ? "starred" : "belowExpectation",
    tag2: "successRate",
    endpoint: agent.endpoint,
    feedbackUri: evidenceUri,
  });
  console.log(`[feedback] on-chain. feedbackTx=${feedbackTxHash}`);

  const receipt: RunRecord = {
    network: cfg.network,
    dryRun: false,
    payerPublicKey: cfg.payerPublicKey,
    agentId: agent.agentId,
    owner: agent.owner,
    endpoint: agent.endpoint,
    challengeNetwork,
    asset,
    payTo,
    price,
    paymentTxHash,
    settlementLedger,
    settlementConfirmedAt,
    resultHash,
    resultOk,
    feedbackTxHash,
    startedAt,
    finishedAt: new Date().toISOString(),
    expertLinks: {
      payment: expertTxLink(cfg, paymentTxHash),
      feedback: expertTxLink(cfg, feedbackTxHash),
      reputationContract: expertContractLink(cfg, REPUTATION_CONTRACT_MAINNET),
      usdcContract: expertContractLink(cfg, USDC_CONTRACT_MAINNET),
    },
  };
  // Do not print an acceptance-evidence banner until every receipt field has
  // passed validation. recordEvidence repeats this check before touching disk.
  assertCompleteEvidenceRecord(receipt);

  // [6] Evidence — two mainnet tx hashes + Stellar Expert links + run.json.
  console.log(`\n=== EVIDENCE (${cfg.network}) ===`);
  console.log(`payment  tx: ${paymentTxHash}\n             ${expertTxLink(cfg, paymentTxHash)}`);
  console.log(`result sha256: ${resultHash}`);
  console.log(`feedback tx: ${feedbackTxHash}\n             ${expertTxLink(cfg, feedbackTxHash)}`);
  const out = await recordEvidence(cfg, receipt);
  console.log(`\n[evidence] wrote ${out}`);
}

const invokedDirectly = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  // Tests import pure validators from this file. Load ambient secrets only for
  // direct CLI execution so a unit-test import never hydrates a real .env key.
  loadDotenv({ path: resolve(HERE, ".env") });
  main().catch((e) => {
    console.error("FATAL:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
