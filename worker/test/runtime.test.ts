import { describe, expect, it } from "vitest";
import {
  HEALTH_PATH,
  MAX_BATCH_ITEMS,
  MAX_BODY_BYTES,
  MAX_UPSTREAM_COST,
  MCP_PATH,
  createExplorerBindingFetch,
  createWorker,
  estimateUpstreamCost,
  heavyToolCallCount,
  type EdgeCache,
  type RateLimitBinding,
  type ServiceBinding,
  type WorkerContext,
  type WorkerEnv,
} from "../src/index.js";

class FakeBinding implements ServiceBinding {
  readonly requests: Request[] = [];
  readonly responseHeaders: Headers;
  calls = 0;

  constructor(
    private readonly body = JSON.stringify({ success: true, data: [], meta: {} }),
    headers: HeadersInit = {
      "cache-control": "public, max-age=30",
      "content-type": "application/json",
    },
  ) {
    this.responseHeaders = new Headers(headers);
  }

  async fetch(request: Request): Promise<Response> {
    this.calls++;
    this.requests.push(request.clone());
    return new Response(this.body, { status: 200, headers: this.responseHeaders });
  }
}

class ThrowingBinding implements ServiceBinding {
  calls = 0;

  async fetch(): Promise<Response> {
    this.calls++;
    throw new Error("binding must not be called");
  }
}

class FakeLimiter implements RateLimitBinding {
  readonly keys: string[] = [];
  calls = 0;

  constructor(
    private readonly denyAt?: number,
    private readonly shouldThrow = false,
  ) {}

  async limit(options: { key: string }): Promise<{ success: boolean }> {
    this.calls++;
    this.keys.push(options.key);
    if (this.shouldThrow) throw new Error("limiter unavailable");
    return { success: this.denyAt === undefined || this.calls < this.denyAt };
  }
}

class FakeCache implements EdgeCache {
  readonly entries = new Map<string, Response>();
  matches = 0;
  puts = 0;

  async match(request: Request): Promise<Response | undefined> {
    this.matches++;
    return this.entries.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.puts++;
    this.entries.set(request.url, response.clone());
  }
}

class TestContext implements WorkerContext {
  readonly pending: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  async drain(): Promise<void> {
    await Promise.all(this.pending);
  }
}

function workerEnv(
  binding: ServiceBinding,
  limiter: RateLimitBinding | null = new FakeLimiter(),
): WorkerEnv {
  return {
    STELLAR8004_API: binding,
    VERIFY_ONCHAIN: "false",
    ...(limiter === null ? {} : { MCP_RATE_LIMITER: limiter }),
  };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function legacyRequest(
  body: unknown,
  options: {
    url?: string;
    origin?: string;
    headers?: HeadersInit;
    userAgent?: string;
    ip?: string;
  } = {},
): Request {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(options.headers ?? {}),
  });
  if (options.origin !== undefined) headers.set("origin", options.origin);
  if (options.userAgent !== undefined) headers.set("user-agent", options.userAgent);
  if (options.ip !== undefined) headers.set("cf-connecting-ip", options.ip);
  return new Request(options.url ?? `http://localhost${MCP_PATH}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function rpcPayload(response: Response): Promise<Record<PropertyKey, unknown>> {
  const text = await response.text();
  const serialized = response.headers.get("content-type")?.includes("text/event-stream")
    ? (text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim() ?? "")
    : text;
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value)) throw new Error("expected a JSON-RPC object response");
  return value;
}

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "worker-test", version: "1.0.0" },
  },
};

const modernDiscoverBody = {
  jsonrpc: "2.0",
  id: 10,
  method: "server/discover",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "worker-modern-test", version: "1.0.0" },
    },
  },
};

function toolCall(name: string, args: Record<string, unknown>, id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

describe("routing, Host, Origin, and CORS admission", () => {
  it("serves only exact /mcp and /healthz paths", async () => {
    const binding = new ThrowingBinding();
    const worker = createWorker({ cache: null });
    const context = new TestContext();

    expect(
      (await worker.fetch(new Request("http://localhost/mcp/"), workerEnv(binding), context)).status,
    ).toBe(404);
    expect(
      (await worker.fetch(new Request("http://localhost/unknown"), workerEnv(binding), context)).status,
    ).toBe(404);
    expect(binding.calls).toBe(0);
  });

  it("rejects an unapproved Host before MCP admission", async () => {
    const worker = createWorker({ cache: null });
    const response = await worker.fetch(
      legacyRequest(initializeBody, { url: "https://evil.example/mcp" }),
      workerEnv(new ThrowingBinding()),
      new TestContext(),
    );
    expect(response.status).toBe(421);
  });

  it("rejects plaintext use of the production Host", async () => {
    const response = await createWorker({ cache: null }).fetch(
      new Request("http://mcp.stellar8004.com/healthz"),
      workerEnv(new ThrowingBinding()),
      new TestContext(),
    );
    expect(response.status).toBe(421);
  });

  it("allows the canonical production Host and localhost development Hosts", async () => {
    const worker = createWorker({ cache: null });
    const production = await worker.fetch(
      new Request(`https://mcp.stellar8004.com${HEALTH_PATH}`),
      workerEnv(new ThrowingBinding()),
      new TestContext(),
    );
    const local = await worker.fetch(
      new Request(`http://127.0.0.1:8787${HEALTH_PATH}`),
      workerEnv(new ThrowingBinding()),
      new TestContext(),
    );
    expect(production.status).toBe(200);
    expect(local.status).toBe(200);
  });

  it("exposes only the opaque served version id for override canaries", async () => {
    const env = workerEnv(new ThrowingBinding());
    env.CF_VERSION_METADATA = {
      id: "dc8dcd28-271b-4367-9840-6c244f84cb40",
      tag: "canary",
    };
    const response = await createWorker({ cache: null }).fetch(
      new Request(`https://mcp.stellar8004.com${HEALTH_PATH}`),
      env,
      new TestContext(),
    );
    expect(response.headers.get("x-worker-version")).toBe(
      "dc8dcd28-271b-4367-9840-6c244f84cb40",
    );
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("rejects unapproved, opaque, and insecure production browser Origins", async () => {
    const worker = createWorker({ cache: null });
    const env = workerEnv(new ThrowingBinding());
    const context = new TestContext();

    for (const origin of ["https://evil.example", "null", "http://stellar8004.com"]) {
      const response = await worker.fetch(legacyRequest(initializeBody, { origin }), env, context);
      expect(response.status).toBe(403);
    }
  });

  it("passes originless MCP clients and echoes only an approved browser Origin", async () => {
    const worker = createWorker({ cache: null });
    const env = workerEnv(new ThrowingBinding());

    const originless = await worker.fetch(
      legacyRequest(initializeBody),
      env,
      new TestContext(),
    );
    expect(originless.status).toBe(200);
    expect(originless.headers.get("access-control-allow-origin")).toBeNull();

    const browser = await worker.fetch(
      legacyRequest("{", { origin: "https://www.stellar8004.com" }),
      env,
      new TestContext(),
    );
    expect(browser.status).toBe(400);
    expect(browser.headers.get("access-control-allow-origin")).toBe(
      "https://www.stellar8004.com",
    );
  });

  it("answers a constrained OPTIONS preflight without reflecting arbitrary headers", async () => {
    const worker = createWorker({ cache: null });
    const allowed = await worker.fetch(
      new Request("http://localhost/mcp", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type, mcp-protocol-version",
        },
      }),
      workerEnv(new ThrowingBinding()),
      new TestContext(),
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(allowed.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(allowed.headers.get("access-control-allow-headers")).not.toContain("authorization");

    const denied = await worker.fetch(
      new Request("http://localhost/mcp", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization",
        },
      }),
      workerEnv(new ThrowingBinding()),
      new TestContext(),
    );
    expect(denied.status).toBe(403);
  });
});

describe("method, body, JSON, batch, and upstream-cost admission", () => {
  it("keeps /mcp POST-only and advertises POST, OPTIONS", async () => {
    const worker = createWorker({ cache: null });
    const env = workerEnv(new ThrowingBinding());
    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await worker.fetch(
        new Request("http://localhost/mcp", { method }),
        env,
        new TestContext(),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST, OPTIONS");
    }
  });

  it("rejects a declared or streamed body above 256 KiB", async () => {
    const worker = createWorker({ cache: null });
    const env = workerEnv(new ThrowingBinding());

    const declared = legacyRequest("{}", {
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    });
    expect((await worker.fetch(declared, env, new TestContext())).status).toBe(413);

    const streamed = legacyRequest(`"${"x".repeat(MAX_BODY_BYTES)}"`);
    expect((await worker.fetch(streamed, env, new TestContext())).status).toBe(413);
  });

  it("rejects malformed JSON before the MCP handler", async () => {
    const response = await createWorker({ cache: null }).fetch(
      legacyRequest("{"),
      workerEnv(new ThrowingBinding()),
      new TestContext(),
    );
    expect(response.status).toBe(400);
    const payload = await rpcPayload(response);
    const error = Reflect.get(payload, "error");
    expect(isRecord(error) ? Reflect.get(error, "code") : undefined).toBe(-32700);
  });

  it(`rejects JSON-RPC batches above ${MAX_BATCH_ITEMS} items`, async () => {
    const batch = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, index) => ({
      jsonrpc: "2.0",
      id: index,
      method: "ping",
      params: {},
    }));
    const response = await createWorker({ cache: null }).fetch(
      legacyRequest(batch),
      workerEnv(new ThrowingBinding()),
      new TestContext(),
    );
    expect(response.status).toBe(413);
  });

  it("counts bounded Explorer and Soroban upper bounds and reserves the full budget for unknown methods", () => {
    const leaderboard = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "leaderboard", arguments: { verify: false } },
    };
    const rankWithoutVerification = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "rank_agent", arguments: { query: "agent", verify: false } },
    };
    const futureModern = {
      jsonrpc: "2.0",
      id: 3,
      method: "future/modern-method",
      params: {
        _meta: { "io.modelcontextprotocol/protocol-version": "2026-07-28" },
      },
    };

    const profileWithoutFeedback = {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_agent_profile", arguments: { agent: 7, feedbackLimit: 0 } },
    };
    const services = {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "list_services", arguments: { limit: 20, page: 1 } },
    };
    const verifiedFind = {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "find_agent", arguments: { query: "agent", verify: true } },
    };
    const verifiedExplicitRank = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "rank_agent",
        arguments: { agentIds: Array.from({ length: 10 }, (_, index) => index), verify: true },
      },
    };
    const maxServicesWindow = {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      // Deliberately above the remote schema: estimation must still clamp to
      // the same caps instead of trusting caller-controlled magnitudes.
      params: { name: "list_services", arguments: { limit: 50, page: 10_000 } },
    };
    const profileWithFeedback = {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "get_agent_profile", arguments: { agent: 7 } },
    };
    const verifiedList = {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "list_agents", arguments: { verify: true } },
    };
    const verifiedOwner = {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "get_agents_by_owner", arguments: { verify: true } },
    };
    const feedback = {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "get_agent_feedback", arguments: { agent: 7, limit: 1 } },
    };
    const verifyReputation = {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "verify_reputation", arguments: { agent: 7 } },
    };

    expect(estimateUpstreamCost(leaderboard)).toBe(3);
    expect(estimateUpstreamCost(rankWithoutVerification)).toBe(2);
    expect(estimateUpstreamCost(profileWithoutFeedback)).toBe(4);
    expect(estimateUpstreamCost(services)).toBe(22);
    expect(estimateUpstreamCost(verifiedFind)).toBe(7);
    expect(estimateUpstreamCost(verifiedExplicitRank)).toBe(13);
    expect(estimateUpstreamCost(maxServicesWindow)).toBe(MAX_UPSTREAM_COST);
    expect(estimateUpstreamCost(profileWithFeedback)).toBe(7);
    expect(estimateUpstreamCost(verifiedList)).toBe(4);
    expect(estimateUpstreamCost(verifiedOwner)).toBe(4);
    expect(estimateUpstreamCost(feedback)).toBe(3);
    expect(estimateUpstreamCost(verifyReputation)).toBe(4);
    expect(
      estimateUpstreamCost({ jsonrpc: "2.0", id: 14, method: "resources/read", params: {} }),
    ).toBe(8);
    expect(
      estimateUpstreamCost({ jsonrpc: "2.0", id: 15, method: "resources/list", params: {} }),
    ).toBe(5);
    expect(
      estimateUpstreamCost({
        jsonrpc: "2.0",
        id: 16,
        method: "resources/templates/list",
        params: {},
      }),
    ).toBe(1);
    expect(estimateUpstreamCost(initializeBody)).toBe(0);
    expect(estimateUpstreamCost(futureModern)).toBe(MAX_UPSTREAM_COST);
    expect(estimateUpstreamCost([futureModern, futureModern])).toBe(
      MAX_UPSTREAM_COST * 2,
    );
  });

  it("rejects multiple heavy calls before either can fan out", async () => {
    const heavy = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "leaderboard", arguments: { verify: false } },
    };
    const response = await createWorker({ cache: null }).fetch(
      legacyRequest([heavy, { ...heavy, id: 2 }]),
      workerEnv(new ThrowingBinding()),
      new TestContext(),
    );
    expect(response.status).toBe(413);
    const payload = await rpcPayload(response);
    const error = Reflect.get(payload, "error");
    const data = isRecord(error) ? Reflect.get(error, "data") : undefined;
    expect(isRecord(data) ? Reflect.get(data, "heavyCalls") : undefined).toBe(2);
  });

  it.each([
    [
      "two verify_reputation calls",
      toolCall("verify_reputation", { agent: 7 }, 101),
      toolCall("verify_reputation", { agent: 8 }, 102),
    ],
    [
      "two default verified profiles",
      toolCall("get_agent_profile", { agent: 7 }, 103),
      toolCall("get_agent_profile", { agent: 8 }, 104),
    ],
    [
      "two feedback-fan-out profiles with verification disabled",
      toolCall("get_agent_profile", { agent: 7, verify: false, feedbackLimit: 1 }, 105),
      toolCall("get_agent_profile", { agent: 8, verify: false, feedbackLimit: 1 }, 106),
    ],
    [
      "two verified agent cards",
      toolCall("get_agent_card", { agent: 7, verify: true }, 107),
      toolCall("get_agent_card", { agent: 8, verify: true }, 108),
    ],
    [
      "two verified agent lists",
      toolCall("list_agents", { verify: true }, 109),
      toolCall("list_agents", { verify: true }, 110),
    ],
    [
      "two verified owner fleets",
      toolCall(
        "get_agents_by_owner",
        { owner: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", verify: true },
        111,
      ),
      toolCall(
        "get_agents_by_owner",
        { owner: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", verify: true },
        112,
      ),
    ],
  ])("rejects %s in one HTTP batch before dispatch", async (_label, first, second) => {
    const binding = new ThrowingBinding();
    const response = await createWorker({ cache: null }).fetch(
      legacyRequest([first, second]),
      workerEnv(binding),
      new TestContext(),
    );

    expect(response.status).toBe(413);
    const payload = await rpcPayload(response);
    const error = Reflect.get(payload, "error");
    const data = isRecord(error) ? Reflect.get(error, "data") : undefined;
    expect(isRecord(error) ? Reflect.get(error, "code") : undefined).toBe(-32012);
    expect(isRecord(data) ? Reflect.get(data, "heavyCalls") : undefined).toBe(2);
    expect(binding.calls).toBe(0);
  });

  it("keeps explicitly non-verifying single-read variants light", () => {
    const light = [
      toolCall("get_agent_profile", { agent: 7, verify: false, feedbackLimit: 0 }, 121),
      toolCall("get_agent_card", { agent: 7, verify: false }, 122),
      toolCall("list_agents", { verify: false }, 123),
      toolCall(
        "get_agents_by_owner",
        { owner: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", verify: false },
        124,
      ),
    ];
    expect(heavyToolCallCount(light)).toBe(0);

    expect(
      heavyToolCallCount([
        toolCall("get_agent_profile", { agent: 7 }, 125),
        toolCall("get_agent_card", { agent: 7, verify: true }, 126),
        toolCall("list_agents", { verify: true }, 127),
        toolCall("get_agents_by_owner", { owner: "owner", verify: true }, 128),
      ]),
    ).toBe(4);
  });

  it("admits one unknown modern request at, but not above, the safe budget", async () => {
    const future = {
      jsonrpc: "2.0",
      id: 1,
      method: "future/modern-method",
      params: { _meta: { future: true } },
    };
    const limiter = new FakeLimiter();
    const single = await createWorker({ cache: null }).fetch(
      legacyRequest(future),
      workerEnv(new ThrowingBinding(), limiter),
      new TestContext(),
    );
    expect(single.status).not.toBe(413);
    expect(limiter.calls).toBe(MAX_UPSTREAM_COST + 1);

    const batched = await createWorker({ cache: null }).fetch(
      legacyRequest([future, future]),
      workerEnv(new ThrowingBinding()),
      new TestContext(),
    );
    expect(batched.status).toBe(413);
  });
});

describe("fail-closed weighted rate limiting", () => {
  it("rejects before reading/dispatch when the base debit is denied", async () => {
    const limiter = new FakeLimiter(1);
    const binding = new ThrowingBinding();
    const response = await createWorker({ cache: null }).fetch(
      legacyRequest(initializeBody),
      workerEnv(binding, limiter),
      new TestContext(),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(binding.calls).toBe(0);
  });

  it("returns 503 when the platform limiter throws", async () => {
    const response = await createWorker({ cache: null }).fetch(
      legacyRequest(initializeBody),
      workerEnv(new ThrowingBinding(), new FakeLimiter(undefined, true)),
      new TestContext(),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("returns 503 when the required limiter binding is missing", async () => {
    const response = await createWorker({ cache: null }).fetch(
      legacyRequest(initializeBody),
      workerEnv(new ThrowingBinding(), null),
      new TestContext(),
    );
    expect(response.status).toBe(503);
  });

  it("keys only on edge-owned IP so User-Agent rotation cannot mint new buckets", async () => {
    const limiter = new FakeLimiter();
    const worker = createWorker({ cache: null });
    const env = workerEnv(new ThrowingBinding(), limiter);

    for (const userAgent of ["agent-a", "agent-a", "agent-b"]) {
      await worker.fetch(
        legacyRequest("{", { ip: "192.0.2.10", userAgent }),
        env,
        new TestContext(),
      );
    }

    expect(limiter.keys).toHaveLength(3);
    expect(limiter.keys[0]).toBe(limiter.keys[1]);
    expect(limiter.keys[2]).toBe(limiter.keys[0]);
    expect(limiter.keys.every((key) => !key.includes("192.0.2.10") && !key.includes("agent"))).toBe(
      true,
    );
  });
});

describe("Explorer Service Binding egress", () => {
  it("rewrites only allowlisted GETs and strips caller, auth, cookie, and proxy headers", async () => {
    const binding = new FakeBinding();
    const context = new TestContext();
    const original = new Request("https://mcp.stellar8004.com/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer caller",
        cookie: "caller=secret",
        "cf-connecting-ip": "192.0.2.25",
        "x-forwarded-for": "203.0.113.1",
        "x-real-ip": "203.0.113.2",
        "mcp-protocol-version": "2025-11-25",
      },
      body: "{}",
    });
    const fetcher = createExplorerBindingFetch({
      binding,
      publicBaseUrl: "https://stellar8004.com",
      originalRequest: original,
      context,
    });

    await fetcher("https://stellar8004.com/api/v1/agents?page=2", {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer sdk",
        cookie: "sdk=secret",
        "x-forwarded-for": "198.51.100.3",
        "x-real-ip": "198.51.100.4",
        "mcp-session-id": "secret-session",
      },
    });

    expect(binding.requests).toHaveLength(1);
    const downstream = binding.requests[0];
    expect(downstream.url).toBe("https://stellar8004.internal/api/v1/agents?page=2");
    expect(downstream.method).toBe("GET");
    expect(downstream.body).toBeNull();
    expect([...downstream.headers.keys()].sort()).toEqual([
      "accept",
      "cf-connecting-ip",
      "x-real-ip",
    ]);
    expect(downstream.headers.get("cf-connecting-ip")).toBe("192.0.2.25");
    expect(downstream.headers.get("x-real-ip")).toBe("192.0.2.25");
    expect(downstream.headers.get("authorization")).toBeNull();
    expect(downstream.headers.get("cookie")).toBeNull();
    expect(downstream.headers.get("x-forwarded-for")).toBeNull();
  });

  it("denies SSRF, non-API paths, and non-GET requests before the binding", async () => {
    const binding = new FakeBinding();
    const fetcher = createExplorerBindingFetch({
      binding,
      publicBaseUrl: "https://stellar8004.com",
      originalRequest: new Request("http://localhost/mcp"),
      context: new TestContext(),
    });

    await expect(fetcher("https://example.com/api/v1/agents")).rejects.toThrow("egress denied");
    await expect(fetcher("https://stellar8004.com/admin")).rejects.toThrow("egress denied");
    await expect(
      fetcher("https://stellar8004.com/api/v1/agents", { method: "POST", body: "{}" }),
    ).rejects.toThrow("egress denied");
    expect(binding.calls).toBe(0);
  });

  it("uses a canonical PoP-local public cache hit before a second binding call", async () => {
    const binding = new FakeBinding("cached-body", {
      "cache-control": "public, max-age=30",
      "content-type": "application/json",
      "x-ratelimit-limit": "100",
      "x-ratelimit-remaining": "41",
      "x-ratelimit-reset": "9999999999",
    });
    const cache = new FakeCache();
    const context = new TestContext();
    const fetcher = createExplorerBindingFetch({
      binding,
      publicBaseUrl: "https://stellar8004.com",
      originalRequest: new Request("http://localhost/mcp"),
      context,
      cache,
    });

    const first = await fetcher("https://stellar8004.com/api/v1/stats");
    expect(await first.text()).toBe("cached-body");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("41");
    await context.drain();
    expect(cache.puts).toBe(1);

    const cached = await fetcher("https://stellar8004.com/api/v1/stats");
    expect(await cached.text()).toBe("cached-body");
    expect(cached.headers.get("x-ratelimit-limit")).toBeNull();
    expect(cached.headers.get("x-ratelimit-remaining")).toBeNull();
    expect(cached.headers.get("x-ratelimit-reset")).toBeNull();
    expect(binding.calls).toBe(1);
    expect(cache.matches).toBe(2);
    expect([...cache.entries.keys()]).toEqual(["https://stellar8004.internal/api/v1/stats"]);
  });

  it("does not cache private, no-store, cookie-setting, or identity-varying responses", async () => {
    const unsafeHeaders: HeadersInit[] = [
      { "cache-control": "public, private=Set-Cookie" },
      { "cache-control": "public, no-store" },
      { "cache-control": "public, max-age=30", "set-cookie": "session=secret" },
      { "cache-control": "public, max-age=30", vary: "Authorization" },
      { "cache-control": "public, max-age=30", vary: "Accept, Cookie" },
    ];

    for (const headers of unsafeHeaders) {
      const cache = new FakeCache();
      const context = new TestContext();
      const fetcher = createExplorerBindingFetch({
        binding: new FakeBinding("unsafe", headers),
        publicBaseUrl: "https://stellar8004.com",
        originalRequest: new Request("http://localhost/mcp"),
        context,
        cache,
      });
      await fetcher("https://stellar8004.com/api/v1/stats");
      await context.drain();
      expect(cache.puts).toBe(0);
      expect(cache.entries.size).toBe(0);
    }
  });
});

describe("health and real MCP factory smoke", () => {
  it("keeps /healthz upstream- and limiter-free", async () => {
    const binding = new ThrowingBinding();
    const limiter = new FakeLimiter(undefined, true);
    const response = await createWorker({ cache: null }).fetch(
      new Request("http://localhost/healthz"),
      workerEnv(binding, limiter),
      new TestContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(binding.calls).toBe(0);
    expect(limiter.calls).toBe(0);
  });

  it("returns an explicit 503 for testnet or a non-canonical Explorer while health stays live", async () => {
    const binding = new ThrowingBinding();
    const worker = createWorker({ cache: null });
    const testnetEnv: WorkerEnv = {
      ...workerEnv(binding),
      STELLAR_NETWORK: "testnet",
      EXPLORER_BASE_URL: "https://testnet.example",
    };
    const customMainnetEnv: WorkerEnv = {
      ...workerEnv(binding),
      STELLAR_NETWORK: "mainnet",
      EXPLORER_BASE_URL: "https://mirror.example",
    };

    for (const env of [testnetEnv, customMainnetEnv]) {
      const mcp = await worker.fetch(legacyRequest(initializeBody), env, new TestContext());
      expect(mcp.status).toBe(503);
      const payload = await rpcPayload(mcp);
      const error = Reflect.get(payload, "error");
      expect(isRecord(error) ? Reflect.get(error, "code") : undefined).toBe(-32050);

      const health = await worker.fetch(
        new Request("http://localhost/healthz"),
        env,
        new TestContext(),
      );
      expect(health.status).toBe(200);
    }
    expect(binding.calls).toBe(0);
  });

  it("accepts the canonical Explorer with a normalized trailing slash", async () => {
    const env: WorkerEnv = {
      ...workerEnv(new ThrowingBinding()),
      STELLAR_NETWORK: "mainnet",
      EXPLORER_BASE_URL: "https://stellar8004.com/",
    };
    const response = await createWorker({ cache: null }).fetch(
      legacyRequest(initializeBody),
      env,
      new TestContext(),
    );
    expect(response.status).toBe(200);
  });

  it("serves the modern 2026-07-28 stateless discovery handshake as application/json", async () => {
    const response = await createWorker({ cache: null }).fetch(
      legacyRequest(modernDiscoverBody, {
        headers: {
          accept: "application/json",
          "mcp-method": "server/discover",
          "mcp-protocol-version": "2026-07-28",
        },
      }),
      workerEnv(new ThrowingBinding()),
      new TestContext(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const payload = await rpcPayload(response);
    const result = Reflect.get(payload, "result");
    const supportedVersions = isRecord(result)
      ? Reflect.get(result, "supportedVersions")
      : undefined;
    expect(Array.isArray(supportedVersions) ? supportedVersions : []).toContain("2026-07-28");
    const meta = isRecord(result) ? Reflect.get(result, "_meta") : undefined;
    const serverInfo = isRecord(meta)
      ? Reflect.get(meta, "io.modelcontextprotocol/serverInfo")
      : undefined;
    expect(isRecord(serverInfo) ? Reflect.get(serverInfo, "name") : undefined).toBe(
      "stellar-agent-mcp",
    );
  });

  it("serves Legacy stateless initialize from an SDK v2 factory", async () => {
    const response = await createWorker({ cache: null }).fetch(
      legacyRequest(initializeBody),
      workerEnv(new ThrowingBinding()),
      new TestContext(),
    );
    expect(response.status).toBe(200);
    const payload = await rpcPayload(response);
    const result = Reflect.get(payload, "result");
    const serverInfo = isRecord(result) ? Reflect.get(result, "serverInfo") : undefined;
    expect(isRecord(serverInfo) ? Reflect.get(serverInfo, "name") : undefined).toBe(
      "stellar-agent-mcp",
    );
  });

  it("lists the capped remote tool schemas over /mcp without touching the Explorer", async () => {
    const binding = new ThrowingBinding();
    const response = await createWorker({ cache: null }).fetch(
      legacyRequest(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { headers: { "mcp-protocol-version": "2025-11-25" } },
      ),
      workerEnv(binding),
      new TestContext(),
    );
    expect(response.status).toBe(200);
    const payload = await rpcPayload(response);
    const result = Reflect.get(payload, "result");
    const tools = isRecord(result) ? Reflect.get(result, "tools") : undefined;
    expect(Array.isArray(tools)).toBe(true);
    const names = Array.isArray(tools)
      ? tools.flatMap((tool) => {
          if (!isRecord(tool)) return [];
          const name = Reflect.get(tool, "name");
          return typeof name === "string" ? [name] : [];
        })
      : [];
    expect(names).toContain("find_agent");
    expect(names).toContain("rank_agent");

    const toolByName = (name: string): Record<PropertyKey, unknown> => {
      const match = Array.isArray(tools)
        ? tools.find((tool) => isRecord(tool) && Reflect.get(tool, "name") === name)
        : undefined;
      if (!isRecord(match)) throw new Error(`missing tool ${name}`);
      return match;
    };
    const propertySchema = (
      toolName: string,
      property: string,
    ): Record<PropertyKey, unknown> => {
      const inputSchema = Reflect.get(toolByName(toolName), "inputSchema");
      const properties = isRecord(inputSchema) ? Reflect.get(inputSchema, "properties") : undefined;
      const schema = isRecord(properties) ? Reflect.get(properties, property) : undefined;
      if (!isRecord(schema)) throw new Error(`missing ${toolName}.${property} schema`);
      return schema;
    };

    expect(Reflect.get(propertySchema("rank_agent", "agentIds"), "maxItems")).toBe(10);
    expect(Reflect.get(propertySchema("rank_agent", "limit"), "maximum")).toBe(10);
    expect(Reflect.get(propertySchema("list_services", "limit"), "maximum")).toBe(20);
    expect(Reflect.get(propertySchema("list_services", "page"), "maximum")).toBe(6);
    expect(binding.calls).toBe(0);
  });

  it("dispatches a real tool through DI to the rewritten Service Binding", async () => {
    const stats = {
      totalAgents: 66,
      totalFeedbacks: 120,
      totalValidations: 7,
      totalUniqueClients: 31,
      averageFeedbackScore: 88,
      agentsWithServices: 20,
      agentsWithX402: 12,
      network: "mainnet",
      protocolDistribution: { a2a: 8, mcp: 11, other: 47 },
      trustDistribution: { reputation: 40, validation: 16, tee: 10 },
    };
    const binding = new FakeBinding(
      JSON.stringify({
        success: true,
        data: stats,
        meta: {
          version: "1",
          chain: "stellar",
          network: "mainnet",
          timestamp: "2026-07-29T00:00:00.000Z",
          requestId: "worker-e2e",
        },
      }),
      { "cache-control": "no-store", "content-type": "application/json" },
    );
    const response = await createWorker({ cache: null }).fetch(
      legacyRequest(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "get_registry_stats", arguments: {} },
        },
        {
          ip: "192.0.2.44",
          headers: {
            authorization: "Bearer must-not-cross",
            "mcp-protocol-version": "2025-11-25",
          },
        },
      ),
      workerEnv(binding),
      new TestContext(),
    );

    expect(response.status).toBe(200);
    const payload = await rpcPayload(response);
    const result = Reflect.get(payload, "result");
    const structured = isRecord(result) ? Reflect.get(result, "structuredContent") : undefined;
    expect(isRecord(structured) ? Reflect.get(structured, "totalAgents") : undefined).toBe(66);
    expect(binding.requests).toHaveLength(1);
    const downstream = binding.requests[0];
    expect(downstream.url).toBe("https://stellar8004.internal/api/v1/stats");
    expect(downstream.headers.get("accept")).toBe("application/json");
    expect(downstream.headers.get("cf-connecting-ip")).toBe("192.0.2.44");
    expect(downstream.headers.get("x-real-ip")).toBe("192.0.2.44");
    expect(downstream.headers.get("authorization")).toBeNull();
  });
});
