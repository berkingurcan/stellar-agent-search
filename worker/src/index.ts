import { createMcpHandler } from "agents/mcp/server";
import packageMetadata from "../../package.json" with { type: "json" };
import {
  RANK_SCORE_MAX,
  loadConfig,
  type Config,
  type EnvironmentMap,
} from "../../src/config.js";
import { TtlCache } from "../../src/lib/explorer.js";
import { buildServer } from "../../src/server.js";
import {
  createToolDeps,
  type ToolRuntimePolicy,
} from "../../src/tools/shared.js";

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/healthz";
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_BATCH_ITEMS = 8;
export const MAX_UPSTREAM_COST = 24;
/** MCP identity baked into the Worker artifact; never mutable through bindings. */
export const WORKER_SERVER_VERSION = packageMetadata.version;
/**
 * Conservative admission charge reserved for one Reputation-contract probe.
 * The current verifier performs only one bounded client-page simulation and
 * deliberately never calls get_summary; spare headroom keeps a future change
 * from silently weakening edge admission before this estimate is reviewed.
 */
const MAX_REPUTATION_VERIFY_COST = 3;

/** Public Cloudflare transport caps. Local stdio keeps the broader schemas. */
export const WORKER_TOOL_POLICY = Object.freeze({
  maxRankAgentIds: 10,
  maxRankLimit: 10,
  maxListServicesLimit: 20,
  maxListServicesPage: 6,
  maxVerifyTopK: 1,
  maxVerificationConcurrency: 1,
  maxFeedbackScanPages: 3,
  maxExplorerConcurrency: 4,
}) satisfies ToolRuntimePolicy;

const SERVICE_BINDING_ORIGIN = "https://stellar8004.internal";
const CANONICAL_EXPLORER_ORIGIN = "https://stellar8004.com";
const CURSOR_SAFE_HOSTS = ["mcp.stellar8004.com", "localhost", "127.0.0.1", "[::1]"];
const BROWSER_ORIGIN_HOSTS = [
  "stellar8004.com",
  "www.stellar8004.com",
  "mcp.stellar8004.com",
  "localhost",
  "127.0.0.1",
  "[::1]",
];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PRODUCTION_ORIGIN_HOSTS = new Set([
  "stellar8004.com",
  "www.stellar8004.com",
  "mcp.stellar8004.com",
]);
const PREFLIGHT_HEADERS = new Set([
  "accept",
  "content-type",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "mcp-session-id",
]);
const ALWAYS_HEAVY_TOOLS = new Set([
  "find_agent",
  "rank_agent",
  "list_services",
  "leaderboard",
  "get_agent_feedback",
  "verify_reputation",
]);

export interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerEnv {
  STELLAR8004_API: ServiceBinding;
  MCP_RATE_LIMITER?: RateLimitBinding;
  STELLAR_NETWORK?: string;
  STELLAR_RPC_URL?: string;
  EXPLORER_BASE_URL?: string;
  VERIFY_ONCHAIN?: string;
  RANK_SCORE_MAX?: string;
  RANK_W_QUALITY?: string;
  RANK_W_VOLUME?: string;
  RANK_W_BREADTH?: string;
  RANK_SIM_SOURCE?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
}

const KNOWN_SENSITIVE_BINDING_NAMES = new Set([
  "DATABASE_URL",
  "DIRECT_URL",
  "POSTGRES_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STELLAR_PRIVATE_KEY",
  "STELLAR_SECRET_KEY",
]);
const SENSITIVE_BINDING_NAME_PART = /(?:^|_)(?:API_KEY|AUTH_TOKEN|BEARER_TOKEN|CLIENT_SECRET|CREDENTIALS?|KEY|MNEMONIC|PASSWORD|PRIVATE_KEY|REFRESH_TOKEN|SECRET|SEED|TOKEN)(?:_|$)/;

export function hasKnownSensitiveRuntimeBinding(env: WorkerEnv): boolean {
  return Reflect.ownKeys(env).some(
    (key) =>
      typeof key === "string" &&
      (KNOWN_SENSITIVE_BINDING_NAMES.has(key) ||
        /^SUPABASE(?:_|$)/.test(key) ||
        /^(?:DATABASE|POSTGRES|PG)(?:_|$)/.test(key) ||
        SENSITIVE_BINDING_NAME_PART.test(key)),
  );
}

export interface WorkerHandler {
  fetch(request: Request, env: WorkerEnv, context: WorkerContext): Promise<Response>;
}

export interface WorkerRuntimeOptions {
  /** `undefined` discovers Cloudflare's PoP-local `caches.default`; `null` disables it. */
  cache?: EdgeCache | null;
}

export interface ExplorerBindingFetchOptions {
  binding: ServiceBinding;
  publicBaseUrl: string;
  originalRequest: Request;
  context: WorkerContext;
  cache?: EdgeCache;
}

type OriginCheck = { ok: true; origin?: string } | { ok: false };
type BodyRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too-large" | "stream-error" };
type LimitAdmission = "allowed" | "denied" | "unavailable";

const isolateExplorerCaches = new Map<string, TtlCache>();
const isolateVerifierCaches = new Map<string, TtlCache>();

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isEdgeCache(value: unknown): value is EdgeCache {
  if (!isRecord(value)) return false;
  return (
    typeof Reflect.get(value, "match") === "function" &&
    typeof Reflect.get(value, "put") === "function"
  );
}

function discoverDefaultCache(): EdgeCache | undefined {
  const storage: unknown = Reflect.get(globalThis, "caches");
  if (!isRecord(storage)) return undefined;
  const candidate: unknown = Reflect.get(storage, "default");
  return isEdgeCache(candidate) ? candidate : undefined;
}

function getIsolateExplorerCache(network: string, baseUrl: string): TtlCache {
  const key = `${network}\u0000${baseUrl}`;
  const existing = isolateExplorerCaches.get(key);
  if (existing) return existing;

  // A deployment normally has one immutable env. The cap prevents preview/test
  // environments in one isolate from growing this actor-neutral cache forever.
  if (isolateExplorerCaches.size >= 8) {
    const oldest = isolateExplorerCaches.keys().next().value;
    if (oldest !== undefined) isolateExplorerCaches.delete(oldest);
  }
  const cache = new TtlCache({ maxEntries: 500 });
  isolateExplorerCaches.set(key, cache);
  return cache;
}

function getIsolateVerifierCache(network: string, rpcUrl: string): TtlCache {
  const key = `${network}\u0000${rpcUrl}`;
  const existing = isolateVerifierCaches.get(key);
  if (existing) return existing;

  if (isolateVerifierCaches.size >= 8) {
    const oldest = isolateVerifierCaches.keys().next().value;
    if (oldest !== undefined) isolateVerifierCaches.delete(oldest);
  }
  const cache = new TtlCache({ maxEntries: 200 });
  isolateVerifierCaches.set(key, cache);
  return cache;
}

function workerEnvironment(env: WorkerEnv): EnvironmentMap {
  return {
    STELLAR_NETWORK: env.STELLAR_NETWORK,
    STELLAR_RPC_URL: env.STELLAR_RPC_URL,
    EXPLORER_BASE_URL: env.EXPLORER_BASE_URL,
    VERIFY_ONCHAIN: env.VERIFY_ONCHAIN,
    RANK_SCORE_MAX: env.RANK_SCORE_MAX,
    RANK_W_QUALITY: env.RANK_W_QUALITY,
    RANK_W_VOLUME: env.RANK_W_VOLUME,
    RANK_W_BREADTH: env.RANK_W_BREADTH,
    RANK_SIM_SOURCE: env.RANK_SIM_SOURCE,
  };
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  const error = data === undefined ? { code, message } : { code, message, data };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error }), { status, headers });
}

function plainResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function appendVary(headers: Headers, value: string): void {
  const values = new Set(
    (headers.get("vary") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  values.add(value);
  headers.set("vary", [...values].join(", "));
}

function withCors(response: Response, origin: string | undefined): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  if (origin !== undefined) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-expose-headers", "mcp-session-id");
    appendVary(headers, "Origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parsedHost(raw: string): { hostname: string; port: string } | undefined {
  if (raw.includes("@") || /[/\\?#]/.test(raw)) return undefined;
  try {
    const parsed = new URL(`http://${raw}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") return undefined;
    return { hostname: parsed.hostname.toLowerCase(), port: parsed.port };
  } catch {
    return undefined;
  }
}

function validHost(request: Request): boolean {
  const url = new URL(request.url);
  const raw = request.headers.get("host") ?? url.host;
  const host = parsedHost(raw);
  if (!host) return false;
  if (host.hostname === "mcp.stellar8004.com") {
    return url.protocol === "https:" && (host.port === "" || host.port === "443");
  }
  return LOCAL_HOSTS.has(host.hostname);
}

function checkOrigin(request: Request): OriginCheck {
  const raw = request.headers.get("origin");
  if (raw === null) return { ok: true };

  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    ) {
      return { ok: false };
    }

    if (PRODUCTION_ORIGIN_HOSTS.has(hostname)) {
      if (parsed.protocol !== "https:" || (parsed.port !== "" && parsed.port !== "443")) {
        return { ok: false };
      }
      return { ok: true, origin: parsed.origin };
    }

    if (LOCAL_HOSTS.has(hostname)) return { ok: true, origin: parsed.origin };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function preflightResponse(request: Request, origin: string | undefined, methods: string): Response {
  const requestedMethod = request.headers.get("access-control-request-method")?.toUpperCase();
  if (requestedMethod === undefined || !methods.split(",").map((v) => v.trim()).includes(requestedMethod)) {
    const response = plainResponse(405, "Method Not Allowed");
    response.headers.set("allow", `${methods}, OPTIONS`);
    return withCors(response, origin);
  }

  const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((header) => !PREFLIGHT_HEADERS.has(header))) {
    return withCors(plainResponse(403, "CORS header denied"), origin);
  }

  const headers = new Headers({
    "access-control-allow-methods": `${methods}, OPTIONS`,
    "access-control-allow-headers": [...PREFLIGHT_HEADERS].join(", "),
    "access-control-max-age": "86400",
    "cache-control": "no-store",
  });
  appendVary(headers, "Origin");
  appendVary(headers, "Access-Control-Request-Method");
  appendVary(headers, "Access-Control-Request-Headers");
  return withCors(new Response(null, { status: 204, headers }), origin);
}

function declaredBodyTooLarge(request: Request): boolean | "invalid" {
  const raw = request.headers.get("content-length");
  if (raw === null) return false;
  if (!/^\d+$/.test(raw)) return "invalid";
  const normalized = raw.replace(/^0+(?=\d)/, "");
  const max = String(MAX_BODY_BYTES);
  if (normalized.length > max.length) return true;
  if (normalized.length === max.length && normalized > max) return true;
  return false;
}

async function readBoundedBody(request: Request): Promise<BodyRead> {
  if (request.body === null) return { ok: true, bytes: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(part.value);
    }
  } catch {
    return { ok: false, reason: "stream-error" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

function parseJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function numberArgument(
  args: Record<PropertyKey, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Reflect.get(args, key);
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function booleanArgument(
  args: Record<PropertyKey, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = Reflect.get(args, key);
  return typeof value === "boolean" ? value : fallback;
}

function toolCallCost(message: Record<PropertyKey, unknown>): number {
  const paramsValue = Reflect.get(message, "params");
  if (!isRecord(paramsValue)) return MAX_UPSTREAM_COST;
  const name = Reflect.get(paramsValue, "name");
  if (typeof name !== "string") return MAX_UPSTREAM_COST;
  const argumentsValue = Reflect.get(paramsValue, "arguments");
  const args = isRecord(argumentsValue) ? argumentsValue : {};

  switch (name) {
    // Worst-case outbound work: Explorer Service Binding reads plus Soroban
    // simulations. Cache hits may make reality cheaper; admission never relies
    // on them. These clamps mirror WORKER_TOOL_POLICY and the tool algorithms.
    case "find_agent":
      return 4 + (booleanArgument(args, "verify", false) ? MAX_REPUTATION_VERIFY_COST : 0);
    case "rank_agent": {
      const idsValue = Reflect.get(args, "agentIds");
      const ids = Array.isArray(idsValue) ? idsValue.length : 0;
      const explorerCost =
        ids > 0 ? Math.min(ids, WORKER_TOOL_POLICY.maxRankAgentIds) : 2;
      return (
        explorerCost +
        (booleanArgument(args, "verify", true) ? MAX_REPUTATION_VERIFY_COST : 0)
      );
    }
    case "list_services": {
      const limit = numberArgument(
        args,
        "limit",
        20,
        1,
        WORKER_TOOL_POLICY.maxListServicesLimit,
      );
      const page = numberArgument(
        args,
        "page",
        1,
        1,
        WORKER_TOOL_POLICY.maxListServicesPage,
      );
      const pages = Math.min(10, Math.ceil((page * limit) / 50) + 1);
      return pages + limit;
    }
    case "leaderboard":
      return 3 + (booleanArgument(args, "verify", false) ? MAX_REPUTATION_VERIFY_COST : 0);
    case "list_agents":
      return 1 + (booleanArgument(args, "verify", false) ? MAX_REPUTATION_VERIFY_COST : 0);
    case "get_agent_profile": {
      const feedbackLimit = numberArgument(args, "feedbackLimit", 5, 0, 50);
      // Revoked rows can force the feedback helper to consume its full scan cap
      // even when the caller requests only one visible row.
      const feedbackPages =
        feedbackLimit > 0 ? WORKER_TOOL_POLICY.maxFeedbackScanPages : 0;
      return (
        1 +
        feedbackPages +
        (booleanArgument(args, "verify", true) ? MAX_REPUTATION_VERIFY_COST : 0)
      );
    }
    case "get_agent_card":
      return 1 + (booleanArgument(args, "verify", false) ? MAX_REPUTATION_VERIFY_COST : 0);
    case "verify_reputation":
      return 1 + MAX_REPUTATION_VERIFY_COST;
    case "get_agents_by_owner":
      return 1 + (booleanArgument(args, "verify", false) ? MAX_REPUTATION_VERIFY_COST : 0);
    case "get_agent_feedback":
      return WORKER_TOOL_POLICY.maxFeedbackScanPages;
    case "resolve_agent":
      return 1;
    case "get_registry_stats":
    case "get_registry_health":
      return 1;
    default:
      return MAX_UPSTREAM_COST;
  }
}

function messageCost(value: unknown): number {
  if (!isRecord(value)) return MAX_UPSTREAM_COST;
  const method = Reflect.get(value, "method");
  if (typeof method !== "string") return MAX_UPSTREAM_COST;

  if (method === "tools/call") return toolCallCost(value);
  // Resource dispatch does not expose a pre-handler URI-to-cost seam. Keep a
  // conservative envelope above the current max (5 Explorer pages or one
  // detail + 3 Soroban calls), while still allowing useful batches.
  if (method === "resources/read") return 8;
  // resources/list invokes the agent-profile template's list callback, whose
  // leaderboard scan can consume five Explorer pages. Template metadata alone
  // performs no upstream work; charge one conservative unit for drift.
  if (method === "resources/list") return 5;
  if (method === "resources/templates/list") return 1;
  if (
    method === "initialize" ||
    method === "server/discover" ||
    method === "tools/list" ||
    method === "prompts/list" ||
    method === "prompts/get" ||
    method === "ping" ||
    method.startsWith("notifications/")
  ) {
    return 0;
  }

  // A future modern envelope still carries a top-level method. One unknown
  // single request is admitted at the whole safe budget; multiple unknowns in
  // a batch are rejected by the sum instead of being misclassified as cheap.
  return MAX_UPSTREAM_COST;
}

export function estimateUpstreamCost(parsedBody: unknown): number {
  if (!Array.isArray(parsedBody)) return messageCost(parsedBody);
  return parsedBody.reduce((sum, item) => sum + messageCost(item), 0);
}

function isHeavyMessage(message: unknown): boolean {
  if (!isRecord(message)) return false;
  const method = Reflect.get(message, "method");
  // Dynamic resource reads can fan out just like tools: agent/profile/card/
  // reputation resources perform Soroban comparisons, leaderboard/list can
  // scan five Explorer pages, and the dispatcher exposes no safe pre-handler
  // URI-to-cost seam. Permit only one such branch per HTTP batch.
  if (method === "resources/read" || method === "resources/list") return true;
  if (method !== "tools/call") return false;
  const params = Reflect.get(message, "params");
  if (!isRecord(params)) return false;
  const name = Reflect.get(params, "name");
  if (typeof name !== "string") return false;
  if (ALWAYS_HEAVY_TOOLS.has(name)) return true;

  const argumentsValue = Reflect.get(params, "arguments");
  const args = isRecord(argumentsValue) ? argumentsValue : {};
  switch (name) {
    case "get_agent_profile":
      // Default profile work verifies on-chain and scans feedback. It is light
      // only when the caller explicitly disables both independent branches.
      return (
        booleanArgument(args, "verify", true) ||
        numberArgument(args, "feedbackLimit", 5, 0, 50) > 0
      );
    case "get_agent_card":
      return booleanArgument(args, "verify", false);
    case "list_agents":
    case "get_agents_by_owner":
      return booleanArgument(args, "verify", false);
    default:
      return false;
  }
}

export function heavyToolCallCount(parsedBody: unknown): number {
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  return messages.reduce((count, message) => count + (isHeavyMessage(message) ? 1 : 0), 0);
}

function trustedConnectingIp(request: Request): string {
  const value = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  // Cloudflare overwrites this header at the production edge. The syntax cap
  // avoids propagating arbitrary local-dev input; x-real-ip/x-forwarded-for are
  // deliberately never consulted.
  if (value.length === 0 || value.length > 64 || !/^[0-9a-f:.]+$/i.test(value)) return "unknown";
  return value;
}

async function admissionKey(request: Request): Promise<string> {
  const ip = trustedConnectingIp(request);
  // Primary abuse bucket is the edge-owned client IP. User-Agent is caller
  // controlled and must not let one direct client mint unlimited buckets.
  const bytes = new TextEncoder().encode(`mcp-rate-v2\u0000${ip}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `mcp:${hex.slice(0, 32)}`;
}

async function debitLimiter(
  limiter: RateLimitBinding | undefined,
  key: string,
  units: number,
): Promise<LimitAdmission> {
  if (limiter === undefined) return "unavailable";
  try {
    for (let index = 0; index < units; index++) {
      if (!(await limiter.limit({ key })).success) return "denied";
    }
    return "allowed";
  } catch {
    // Public MCP work has real upstream/RPC cost. A limiter outage must not
    // silently turn the endpoint into an unlimited anonymous relay.
    return "unavailable";
  }
}

function publicApiBase(value: string): URL {
  const base = new URL(value);
  if (
    base.protocol !== "https:" ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    throw new Error("Explorer base must be a public HTTPS URL");
  }
  return base;
}

function allowedApiUrl(url: URL, base: URL): boolean {
  if (url.origin !== base.origin || url.username !== "" || url.password !== "" || url.hash !== "") {
    return false;
  }
  // URL normalizes an assigned empty pathname back to "/". Keep the normalized
  // root as a local string so a root deployment produces "/api", not "//api".
  const root = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
  const path = url.pathname;
  return (
    path === `${root}/api/v1` ||
    path.startsWith(`${root}/api/v1/`) ||
    path === `${root}/api/v2` ||
    path.startsWith(`${root}/api/v2/`)
  );
}

function responseIsPubliclyCacheable(response: Response): boolean {
  if (response.status !== 200 || response.headers.has("set-cookie")) return false;
  const cacheControl = (response.headers.get("cache-control") ?? "")
    .toLowerCase()
    .split(",")
    .map((part) => part.trim());
  const hasDirective = (name: string): boolean =>
    cacheControl.some((directive) => directive === name || directive.startsWith(`${name}=`));
  if (!hasDirective("public") || hasDirective("private") || hasDirective("no-store")) {
    return false;
  }
  const vary = (response.headers.get("vary") ?? "")
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return !vary.some((name) => name === "*" || name === "authorization" || name === "cookie");
}

function responseForSharedCache(response: Response): Response {
  const cloned = response.clone();
  const headers = new Headers(cloned.headers);
  for (const name of [...headers.keys()]) {
    // The upstream limiter describes the current actor/request. Replaying it to
    // another MCP caller would leak and misrepresent their remaining budget.
    if (name.toLowerCase().startsWith("x-ratelimit-")) headers.delete(name);
  }
  return new Response(cloned.body, {
    status: cloned.status,
    statusText: cloned.statusText,
    headers,
  });
}

function bypassSharedCaches(request: Request): boolean {
  const directives = (request.headers.get("cache-control") ?? "")
    .toLowerCase()
    .split(",")
    .map((directive) => directive.trim());
  return directives.some(
    (directive) =>
      directive === "no-cache" ||
      directive === "no-store" ||
      directive === "max-age=0",
  );
}

export function createExplorerBindingFetch(options: ExplorerBindingFetchOptions): typeof fetch {
  const base = publicApiBase(options.publicBaseUrl);
  const connectingIp = trustedConnectingIp(options.originalRequest);
  const bypassCache = bypassSharedCaches(options.originalRequest);

  return async (input, init) => {
    const requested = new Request(input, init);
    const requestedUrl = new URL(requested.url);
    if (requested.method.toUpperCase() !== "GET" || !allowedApiUrl(requestedUrl, base)) {
      throw new Error("Explorer egress denied by Worker allowlist");
    }

    const rewritten = new URL(`${requestedUrl.pathname}${requestedUrl.search}`, SERVICE_BINDING_ORIGIN);
    const cacheKey = new Request(rewritten, { method: "GET" });

    // Cache API entries are PoP-local and best effort. The SDK/TtlCache path is
    // still authoritative when `caches.default` is absent or fails.
    if (!bypassCache && options.cache !== undefined) {
      try {
        const hit = await options.cache.match(cacheKey);
        if (hit !== undefined) return hit.clone();
      } catch {
        // Ignore Cache API failure and use the bound service.
      }
    }

    const headers = new Headers();
    const accept = requested.headers.get("accept");
    headers.set("accept", accept && accept.length <= 256 ? accept : "application/json");
    if (connectingIp !== "unknown") {
      headers.set("cf-connecting-ip", connectingIp);
      // Same-zone Worker subrequests derive CF-Connecting-IP from x-real-ip.
      // Both values originate only from Cloudflare's trusted incoming header.
      headers.set("x-real-ip", connectingIp);
    }

    // A standards-compliant Request cannot derive a bodyless GET from the
    // original POST while retaining non-standard request.cf metadata: Fetch
    // inherits the POST body and rejects the method override. Build a fresh GET
    // and copy only the edge-owned identity header. Whether a future workerd
    // RequestInit.cf seam can retain getClientAddress metadata safely is a live
    // canary item; Authorization, Cookie, MCP and caller forwarding headers stay
    // stripped regardless.
    const downstream = new Request(rewritten, {
      method: "GET",
      headers,
      redirect: "manual",
    });
    const response = await options.binding.fetch(downstream);

    if (!bypassCache && options.cache !== undefined && responseIsPubliclyCacheable(response)) {
      const write = options.cache
        .put(cacheKey, responseForSharedCache(response))
        .catch(() => undefined);
      options.context.waitUntil(write);
    }
    return response;
  };
}

function rebuiltRequest(request: Request, bytes: Uint8Array): Request {
  const body = Uint8Array.from(bytes).buffer;
  const headers = new Headers(request.headers);
  // workerd supplies Host on real incoming requests; standards-based Node test
  // Request objects do not. The outer gate already validated this URL/Host.
  if (!headers.has("host")) headers.set("host", new URL(request.url).host);
  return new Request(request.url, {
    method: "POST",
    headers,
    body,
    redirect: request.redirect,
    signal: request.signal,
  });
}

function isCanonicalRemoteConfig(config: Config): boolean {
  if (
    config.network !== "mainnet" ||
    config.verifyOnchain !== true ||
    config.scoreMax !== RANK_SCORE_MAX ||
    config.simSource !== undefined
  ) {
    return false;
  }
  try {
    const explorer = new URL(config.explorerBaseUrl);
    const rpc = new URL(config.rpcUrl);
    const canonicalRpc = new URL(config.stellar.rpcUrl);
    return (
      explorer.origin === CANONICAL_EXPLORER_ORIGIN &&
      explorer.pathname.replace(/\/+$/, "") === "" &&
      explorer.search === "" &&
      explorer.hash === "" &&
      explorer.username === "" &&
      explorer.password === "" &&
      rpc.href === canonicalRpc.href &&
      rpc.protocol === "https:" &&
      rpc.username === "" &&
      rpc.password === "" &&
      rpc.search === "" &&
      rpc.hash === ""
    );
  } catch {
    return false;
  }
}

function operatorConfigError(origin: string | undefined): Response {
  return withCors(
    jsonRpcError(
      503,
      -32050,
      "This Worker accepts only the canonical mainnet Explorer/RPC, enabled on-chain verification, and release ranking policy.",
    ),
    origin,
  );
}

function rateLimited(origin: string | undefined): Response {
  const response = jsonRpcError(429, -32029, "Rate limit exceeded; retry later.");
  response.headers.set("retry-after", "60");
  return withCors(response, origin);
}

function limiterUnavailable(origin: string | undefined): Response {
  const response = jsonRpcError(503, -32030, "Admission control is temporarily unavailable.");
  response.headers.set("retry-after", "5");
  return withCors(response, origin);
}

async function handleMcp(
  request: Request,
  env: WorkerEnv,
  context: WorkerContext,
  runtime: WorkerRuntimeOptions,
  origin: string | undefined,
): Promise<Response> {
  if (request.method === "OPTIONS") return preflightResponse(request, origin, "POST");
  if (request.method !== "POST") {
    const response = jsonRpcError(405, -32600, "Method Not Allowed");
    response.headers.set("allow", "POST, OPTIONS");
    return withCors(response, origin);
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return withCors(jsonRpcError(415, -32600, "Content-Type must be application/json."), origin);
  }

  const declaredSize = declaredBodyTooLarge(request);
  if (declaredSize === "invalid") {
    return withCors(jsonRpcError(400, -32600, "Invalid Content-Length header."), origin);
  }
  if (declaredSize) {
    return withCors(jsonRpcError(413, -32010, "MCP request body exceeds 256 KiB."), origin);
  }

  const limiterKey = await admissionKey(request);
  const baseAdmission = await debitLimiter(env.MCP_RATE_LIMITER, limiterKey, 1);
  if (baseAdmission === "denied") return rateLimited(origin);
  if (baseAdmission === "unavailable") return limiterUnavailable(origin);

  const body = await readBoundedBody(request);
  if (!body.ok) {
    const message =
      body.reason === "too-large"
        ? "MCP request body exceeds 256 KiB."
        : "Unable to read MCP request body.";
    return withCors(jsonRpcError(body.reason === "too-large" ? 413 : 400, -32700, message), origin);
  }

  const parsed = parseJson(body.bytes);
  if (!parsed.ok) return withCors(jsonRpcError(400, -32700, "Parse error."), origin);
  if (Array.isArray(parsed.value) && parsed.value.length > MAX_BATCH_ITEMS) {
    return withCors(
      jsonRpcError(413, -32600, `JSON-RPC batch exceeds ${MAX_BATCH_ITEMS} items.`),
      origin,
    );
  }

  const heavyCalls = heavyToolCallCount(parsed.value);
  if (heavyCalls > 1) {
    return withCors(
      jsonRpcError(
        413,
        -32012,
        "A JSON-RPC batch may contain at most one fan-out/on-chain branch (tool or dynamic resource).",
        {
          heavyCalls,
          maxHeavyCalls: 1,
        },
      ),
      origin,
    );
  }

  const estimatedCost = estimateUpstreamCost(parsed.value);
  if (estimatedCost > MAX_UPSTREAM_COST) {
    return withCors(
      jsonRpcError(413, -32011, "Estimated upstream request cost exceeds the Worker budget.", {
        estimatedCost,
        maxCost: MAX_UPSTREAM_COST,
      }),
      origin,
    );
  }

  if (baseAdmission === "allowed" && estimatedCost > 0) {
    // The admission debit is per request; Explorer Service Binding work is an
    // additional charge, so a cost-N request consumes 1 + N limiter units.
    const weightedAdmission = await debitLimiter(env.MCP_RATE_LIMITER, limiterKey, estimatedCost);
    if (weightedAdmission === "denied") return rateLimited(origin);
    if (weightedAdmission === "unavailable") return limiterUnavailable(origin);
  }

  let config: Config;
  try {
    config = loadConfig(workerEnvironment(env));
  } catch {
    return operatorConfigError(origin);
  }
  // SERVER_VERSION used to be a mutable binding. Reject a stale dashboard
  // secret/config explicitly instead of silently letting release identity drift.
  if (Reflect.has(env, "SERVER_VERSION") || !isCanonicalRemoteConfig(config)) {
    return operatorConfigError(origin);
  }

  const bypassCache = bypassSharedCaches(request);
  const edgeCache = bypassCache
    ? undefined
    : runtime.cache === undefined
      ? discoverDefaultCache()
      : runtime.cache ?? undefined;
  const explorerFetch = createExplorerBindingFetch({
    binding: env.STELLAR8004_API,
    publicBaseUrl: config.explorerBaseUrl,
    originalRequest: request,
    context,
    ...(edgeCache === undefined ? {} : { cache: edgeCache }),
  });
  const deps = createToolDeps(config, {
    explorer: {
      fetch: explorerFetch,
      // A canary/freshness probe must exercise the Service Binding rather than
      // succeeding from a previous request's isolate cache. Keep request-local
      // single-flight semantics without sharing cached values across requests.
      cache: bypassCache
        ? new TtlCache({ maxEntries: 8 })
        : getIsolateExplorerCache(config.network, config.explorerBaseUrl),
    },
    verifier: {
      cache: getIsolateVerifierCache(config.network, config.rpcUrl),
    },
  });
  deps.policy = WORKER_TOOL_POLICY;

  const handler = createMcpHandler(
    () =>
      buildServer(config, {
        deps,
        version: WORKER_SERVER_VERSION,
      }),
    {
      route: MCP_PATH,
      corsOptions: false,
      allowedHostnames: CURSOR_SAFE_HOSTS,
      allowedOriginHostnames: BROWSER_ORIGIN_HOSTS,
      legacy: "stateless",
      responseMode: "auto",
    },
  );

  const response = await handler.fetch(rebuiltRequest(request, body.bytes), {
    parsedBody: parsed.value,
  });
  return withCors(response, origin);
}

function healthResponse(
  method: string,
  origin: string | undefined,
  versionId: string | undefined,
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  const body = method === "HEAD" ? null : JSON.stringify({ status: "ok" });
  if (versionId && /^[0-9a-f-]{36}$/i.test(versionId)) {
    headers.set("x-worker-version", versionId);
  }
  return withCors(new Response(body, { status: 200, headers }), origin);
}

export function createWorker(runtime: WorkerRuntimeOptions = {}): WorkerHandler {
  return {
    async fetch(request, env, context) {
      const path = new URL(request.url).pathname;
      if (path !== MCP_PATH && path !== HEALTH_PATH) return plainResponse(404, "Not Found");

      if (!validHost(request)) return plainResponse(421, "Misdirected Request");
      const checkedOrigin = checkOrigin(request);
      if (!checkedOrigin.ok) return plainResponse(403, "Origin denied");

      // Wrangler preserves dashboard/API secrets across normal deploys. The
      // remote predeploy gate inventories them, and this name-only guard is a
      // second line of defense if a known credential binding reaches runtime.
      // Never reflect the binding name: even secret names are operational data.
      if (hasKnownSensitiveRuntimeBinding(env)) {
        return withCors(plainResponse(503, "Operator configuration rejected"), checkedOrigin.origin);
      }

      if (path === HEALTH_PATH) {
        if (request.method === "OPTIONS") {
          return preflightResponse(request, checkedOrigin.origin, "GET, HEAD");
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          const response = plainResponse(405, "Method Not Allowed");
          response.headers.set("allow", "GET, HEAD, OPTIONS");
          return withCors(response, checkedOrigin.origin);
        }
        return healthResponse(request.method, checkedOrigin.origin, env.CF_VERSION_METADATA?.id);
      }

      try {
        return await handleMcp(request, env, context, runtime, checkedOrigin.origin);
      } catch (error) {
        console.error("worker MCP request failed", error instanceof Error ? error.name : "unknown");
        return withCors(jsonRpcError(500, -32603, "Internal server error."), checkedOrigin.origin);
      }
    },
  };
}

export default createWorker();
