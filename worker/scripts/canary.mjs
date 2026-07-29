import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PRODUCTION_ORIGIN = "https://mcp.stellar8004.com";
const PROTOCOL_VERSION = "2025-11-25";

function fail(message) {
  throw new Error(message);
}

function readArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) fail(`Expected --name value, got '${key ?? ""}'`);
    values.set(key.slice(2), value);
  }
  const versionId = values.get("version-id");
  if (!versionId || !/^[0-9a-f-]{36}$/i.test(versionId)) {
    fail("--version-id must be the exact candidate Worker version UUID");
  }
  const label = values.get("client-label");
  if (!label || !/^[A-Za-z0-9_.-]{1,64}$/.test(label)) {
    fail("--client-label must be 1..64 safe characters and identify this physical client");
  }
  const origin = values.get("origin") ?? PRODUCTION_ORIGIN;
  const parsed = new URL(origin);
  if (parsed.origin !== PRODUCTION_ORIGIN || parsed.pathname !== "/") {
    fail(`--origin must be exactly ${PRODUCTION_ORIGIN}/`);
  }
  return { origin: parsed.origin, versionId, label };
}

function overrideHeader(versionId) {
  return `stellar-agent-mcp="${versionId}"`;
}

async function responsePayload(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .find(Boolean);
    if (!data) fail("MCP response contained no SSE data event");
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

async function rpc(origin, versionId, body, sessionId) {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "cloudflare-workers-version-overrides": overrideHeader(versionId),
  });
  if (sessionId) headers.set("mcp-session-id", sessionId);
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "error",
  });
  if (!response.ok) fail(`MCP request failed with HTTP ${response.status}`);
  const payload = await responsePayload(response);
  if (payload?.error) fail(`MCP error ${payload.error.code}: ${payload.error.message}`);
  return { payload, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
}

export async function runCanary(options) {
  const commonHeaders = {
    "cache-control": "no-cache",
    "cloudflare-workers-version-overrides": overrideHeader(options.versionId),
  };
  const health = await fetch(`${options.origin}/healthz`, {
    headers: commonHeaders,
    redirect: "error",
  });
  if (health.status !== 200) fail(`/healthz returned HTTP ${health.status}`);
  if (health.headers.get("x-worker-version") !== options.versionId) {
    fail("Version override was not proven by x-worker-version; do not promote this deployment");
  }
  const healthBody = await health.json();
  if (healthBody?.status !== "ok") fail("/healthz returned an unexpected body");

  const marker = `${options.label}-${randomUUID()}`;
  const initialized = await rpc(options.origin, options.versionId, {
    jsonrpc: "2.0",
    id: `${marker}-initialize`,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: `stellar-agent-mcp-canary-${options.label}`, version: "1.0.0" },
    },
  });
  const toolCall = await rpc(
    options.origin,
    options.versionId,
    {
      jsonrpc: "2.0",
      id: `${marker}-registry-health`,
      method: "tools/call",
      params: { name: "get_registry_health", arguments: {} },
    },
    initialized.sessionId,
  );
  if (!toolCall.payload?.result) fail("get_registry_health returned no result");

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    clientLabel: options.label,
    marker,
    versionId: options.versionId,
    checks: {
      versionOverride: true,
      shallowHealth: true,
      mcpInitialize: true,
      explorerServiceBindingPath: true,
      originalCallerIdentity: "requires-upstream-log-comparison-with-second-physical-client",
    },
  };
}

async function main() {
  try {
    console.log(JSON.stringify(await runCanary(readArgs(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(`CANARY FAILED: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
