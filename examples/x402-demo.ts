/**
 * examples/x402-demo.ts — the reference "agent-finds-agent" loop (SOW Deliverable 2).
 *
 * One autonomous agent, no human in the loop:
 *   [1] PREFLIGHT   — Horizon balances (USDC trustline? USDC >= min? XLM >= min for the
 *                     self-paid feedback tx?), RPC health, facilitator key, payer != scrapper owner.
 *   [2] DISCOVER    — spawn OUR read-only MCP server over stdio (secret-free child env) and call
 *                     find_agent + get_agent_profile to resolve the scrapper's endpoint + capabilities.
 *   [3] PAY (x402)  — manual 402 flow via @x402/fetch + @x402/stellar against the OZ mainnet facilitator;
 *                     payTo comes from the 402 challenge. Real mainnet USDC.
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
 * DRY_RUN=1 → preflight (advisory) + discovery only; no payment, no feedback, no spend. Lets the loop be
 * rehearsed / typechecked / run without real funds.
 *
 * This is a SEPARATE process from src/ and is deliberately allowed to import signing libraries.
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { x402Client, x402HTTPClient, decodePaymentResponseHeader } from "@x402/fetch";
import {
  createEd25519Signer,
  ExactStellarScheme,
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
  STELLAR_WILDCARD_CAIP2,
} from "@x402/stellar";
import type { PaymentRequired } from "@x402/core/types";

import {
  createClients,
  wrapBasicSigner,
  MAINNET_CONFIG,
  TESTNET_CONFIG,
} from "@trionlabs/stellar8004";
import type { StellarConfig } from "@trionlabs/stellar8004";
import { Keypair } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Constants (mainnet — CONTEXT §1 / §7 LIVE-VERIFIED)
// ---------------------------------------------------------------------------

/** Fallbacks for the live scrapper (agent id 10) if MCP discovery is degraded. */
const SCRAPPER_FALLBACK_ID = 10;
const SCRAPPER_FALLBACK_ENDPOINT = "https://scrapper.stellar8004.com/task";
/** Scrapper owner — payer MUST differ (on-chain SelfFeedback guard, code 1). */
const SCRAPPER_OWNER = "GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V";

const REPUTATION_CONTRACT_MAINNET = "CBOIAIMMWAXI57OATLX6BWVDQLCC4YU55HV6MZXFRP6CBSGAMXSTEPPA";
const USDC_CONTRACT_MAINNET = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type NetworkLabel = "mainnet" | "testnet";
type Caip2 = typeof STELLAR_PUBNET_CAIP2 | typeof STELLAR_TESTNET_CAIP2;

interface DemoConfig {
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
  dryRun: boolean;
  /** Present only when STELLAR_PRIVATE_KEY is set (required for a real run). */
  payerPublicKey: string | null;
  /** HTTP method + JSON body used to invoke the scrapper task endpoint. */
  scrapeMethod: string;
  scrapeBody: string | null;
}

function loadConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const raw = (env.STELLAR_NETWORK ?? "mainnet").toLowerCase();
  if (raw !== "mainnet" && raw !== "testnet") {
    throw new Error(`STELLAR_NETWORK must be 'mainnet' or 'testnet', got '${raw}'`);
  }
  const network = raw as NetworkLabel;
  const isMain = network === "mainnet";

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

  return {
    network,
    caip2: isMain ? STELLAR_PUBNET_CAIP2 : STELLAR_TESTNET_CAIP2,
    rpcUrl:
      env.STELLAR_RPC_URL?.trim() ||
      (isMain ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org"),
    horizonUrl: isMain ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org",
    explorerBaseUrl: env.EXPLORER_BASE_URL?.trim() || null,
    mcpServerEntry,
    stellar: isMain ? MAINNET_CONFIG : TESTNET_CONFIG,
    minUsdc: numEnv(env.MIN_USDC, 0.1),
    minXlm: numEnv(env.MIN_XLM, 3),
    dryRun: env.DRY_RUN === "1" || env.DRY_RUN?.toLowerCase() === "true",
    payerPublicKey,
    scrapeMethod: (env.SCRAPE_METHOD ?? "POST").toUpperCase(),
    scrapeBody: env.SCRAPE_BODY ?? JSON.stringify({ url: env.SCRAPE_TARGET ?? "https://example.com" }),
  };
}

function numEnv(v: string | undefined, dflt: number): number {
  if (v == null || v.trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
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
    [
      "facilitator key set (mainnet)",
      async () => {
        if (cfg.network === "mainnet" && !process.env.X402_API_KEY) {
          throw new Error("X402_API_KEY not set (needed for the OZ mainnet facilitator path)");
        }
      },
    ],
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
        const usdc = bals.find((b) => b.asset_type !== "native" && b.asset_code === "USDC");
        if (!usdc) throw new Error("USDC trustline missing — transfers FAIL SILENTLY; add trustline first");
      },
    ],
    [
      "USDC balance sufficient",
      async () => {
        if (!cfg.payerPublicKey) throw new Error("skipped (no payer key)");
        const bals = await horizonBalances(cfg, cfg.payerPublicKey);
        const usdc = Number(bals.find((b) => b.asset_type !== "native" && b.asset_code === "USDC")?.balance ?? 0);
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

interface ResolvedAgent {
  agentId: number;
  name: string | null;
  endpoint: string;
  /** Cross-check only; the authoritative payTo comes from the 402 challenge. */
  wallet: string | null;
  owner: string | null;
  x402Enabled: boolean;
}

function structured(res: unknown): Record<string, any> {
  const sc = (res as { structuredContent?: unknown } | null)?.structuredContent;
  return (sc as Record<string, any>) ?? {};
}

/** Choose the scrapper from a find_agent result: prefer an x402 agent whose declared name/services scream "scraper". */
function pickScrapper(agents: any[]): any | null {
  if (!Array.isArray(agents) || agents.length === 0) return null;
  const scored = agents.map((a) => {
    const decl = a?.selfDeclared?.value ?? {};
    const hay = `${decl?.name ?? ""} ${(decl?.services ?? []).map((s: any) => `${s?.name} ${s?.endpoint}`).join(" ")}`.toLowerCase();
    const nameHit = /scrap/.test(hay) ? 2 : 0;
    const x402Hit = a?.capabilities?.x402 ? 1 : 0;
    return { a, score: nameHit + x402Hit };
  });
  scored.sort((x, y) => y.score - x.score);
  return scored[0]?.a ?? null;
}

/** Resolve the x402 task endpoint from a profile's self-declared services. */
function resolveEndpoint(profile: Record<string, any>): string {
  const services: any[] = profile?.selfDeclared?.services ?? [];
  const https = services.filter((s) => typeof s?.endpoint === "string" && s.endpoint.startsWith("https://"));
  const taskish = https.find((s) => /task|scrap|api/i.test(String(s.endpoint)));
  return String(taskish?.endpoint ?? https[0]?.endpoint ?? SCRAPPER_FALLBACK_ENDPOINT);
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
    const agents: any[] = structured(found).agents ?? [];
    const hit = pickScrapper(agents);

    const agentId: number = typeof hit?.id === "number" ? hit.id : SCRAPPER_FALLBACK_ID;

    const prof = await mcp.callTool({ name: "get_agent_profile", arguments: { agent: agentId } });
    const profile = structured(prof).profile ?? {};

    const decl = profile?.selfDeclared ?? {};
    return {
      agentId: typeof profile?.id === "number" ? profile.id : agentId,
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
  paymentTxHash: string;
  payTo: string;
  price: string;
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
  const { client, http } = buildX402(cfg);
  const url = agent.endpoint;

  // 1) First request — expect HTTP 402.
  const first = await fetch(url, scrapeInit(cfg));
  if (first.status !== 402) {
    if (first.ok) {
      return { result: await safeJson(first), paymentTxHash: "", payTo: "", price: "" };
    }
    throw new Error(`expected 402 from ${url}, got ${first.status}`);
  }

  // 2) Decode the payment requirement from the challenge headers.
  const required: PaymentRequired = http.getPaymentRequiredResponse((name) => first.headers.get(name));
  const accept = required.accepts?.[0];
  if (!accept) throw new Error("402 challenge carried no payment requirements");
  if (accept.network !== cfg.caip2) {
    throw new Error(`network mismatch: challenge=${accept.network} expected=${cfg.caip2}`);
  }
  const payTo = accept.payTo;
  const price = accept.amount;
  if (agent.wallet && agent.wallet !== payTo) {
    process.stderr.write(`[pay] note: profile.wallet ${agent.wallet} != challenge payTo ${payTo} (challenge is authoritative)\n`);
  }

  // 3) + 4) Sign + retry. At most one fresh-payload retry (auth-entry expiry ~60s) — never double-spend.
  let paid = await settleOnce(client, http, url, cfg, required);
  if (paid.status === 402) {
    process.stderr.write("[pay] first settle rejected (likely auth expiry) — rebuilding payload once\n");
    paid = await settleOnce(client, http, url, cfg, required);
  }
  if (paid.status === 402) {
    const retry = http.getPaymentRequiredResponse((name) => paid.headers.get(name));
    throw new Error(`payment rejected by facilitator: ${JSON.stringify(retry)}`);
  }
  if (!paid.ok) throw new Error(`service error after payment: ${paid.status}`);

  // 5) Settlement tx hash from PAYMENT-RESPONSE (base64 SettleResponse.transaction).
  const paymentTxHash = decodeSettlementTxHash(paid.headers.get("PAYMENT-RESPONSE"));
  return { result: await safeJson(paid), paymentTxHash, payTo, price };
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

function decodeSettlementTxHash(header: string | null): string {
  if (!header) return "";
  try {
    return decodePaymentResponseHeader(header).transaction ?? "";
  } catch {
    // Fallback: header may already be a base64 JSON blob with a tx hash field.
    try {
      const obj = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      return String(obj.transaction ?? obj.txHash ?? obj.hash ?? "");
    } catch {
      return "";
    }
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
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
  if (!hash) throw new Error("give_feedback: could not extract tx hash from SentTransaction");
  return hash;
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

interface RunRecord {
  network: NetworkLabel;
  dryRun: boolean;
  payerPublicKey: string | null;
  agentId: number;
  endpoint: string;
  payTo: string;
  price: string;
  paymentTxHash: string;
  feedbackTxHash: string;
  startedAt: string;
  finishedAt: string;
  expertLinks: Record<string, string>;
}

async function recordEvidence(cfg: DemoConfig, rec: RunRecord): Promise<string> {
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
  if (!agent.x402Enabled) {
    console.log("[discover] WARNING: resolved agent does not advertise x402 at the agent level");
  }
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
      endpoint: agent.endpoint,
      payTo: "",
      price: "",
      paymentTxHash: "",
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

  if (!agent.x402Enabled) throw new Error("resolved agent is not x402-enabled — aborting real run");

  // [3/4] Pay via x402 and receive the scraped result (real mainnet USDC).
  const { result, paymentTxHash, payTo, price } = await payForService(cfg, agent);
  console.log(`[pay] settled. payTo=${payTo} price=${price} paymentTx=${paymentTxHash}`);
  console.log(`[result] ${JSON.stringify(result).slice(0, 240)}...`);

  // [5] Write on-chain reputation. Score derived from the successful outcome.
  const evidenceUri = `data:application/json;base64,${Buffer.from(
    JSON.stringify({ agentId: agent.agentId, endpoint: agent.endpoint, paymentTxHash, resultOk: true, ts: startedAt }),
  ).toString("base64")}`;
  const feedbackTxHash = await writeFeedback(cfg, {
    agentId: agent.agentId,
    value: 95,
    tag1: "starred",
    tag2: "successRate",
    endpoint: agent.endpoint,
    feedbackUri: evidenceUri,
  });
  console.log(`[feedback] on-chain. feedbackTx=${feedbackTxHash}`);

  // [6] Evidence — two mainnet tx hashes + Stellar Expert links + run.json.
  console.log(`\n=== EVIDENCE (${cfg.network}) ===`);
  console.log(`payment  tx: ${paymentTxHash}\n             ${expertTxLink(cfg, paymentTxHash)}`);
  console.log(`feedback tx: ${feedbackTxHash}\n             ${expertTxLink(cfg, feedbackTxHash)}`);
  const out = await recordEvidence(cfg, {
    network: cfg.network,
    dryRun: false,
    payerPublicKey: cfg.payerPublicKey,
    agentId: agent.agentId,
    endpoint: agent.endpoint,
    payTo,
    price,
    paymentTxHash,
    feedbackTxHash,
    startedAt,
    finishedAt: new Date().toISOString(),
    expertLinks: {
      payment: expertTxLink(cfg, paymentTxHash),
      feedback: expertTxLink(cfg, feedbackTxHash),
      reputationContract: expertContractLink(cfg, REPUTATION_CONTRACT_MAINNET),
      usdcContract: expertContractLink(cfg, USDC_CONTRACT_MAINNET),
    },
  });
  console.log(`\n[evidence] wrote ${out}`);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
