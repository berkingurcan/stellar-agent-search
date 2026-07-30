import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PRODUCTION_ORIGIN = "https://mcp.stellar8004.com";
const PROTOCOL_VERSION = "2025-11-25";
const SERVER_NAME = "stellar-agent-market";
const packageMetadata = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
export const EXPECTED_SERVER_VERSION = packageMetadata.version;

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return `stellar-agent-market="${versionId}"`;
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
    "cache-control": "no-cache",
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
  if (!isRecord(payload) || payload.jsonrpc !== "2.0" || payload.id !== body.id) {
    fail("MCP response did not match the JSON-RPC request id/version");
  }
  return { payload, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
}

function assertInitializeResult(payload) {
  const result = payload.result;
  if (!isRecord(result)) fail("initialize returned no result object");
  if (result.protocolVersion !== PROTOCOL_VERSION) {
    fail(`initialize protocolVersion must be exactly ${PROTOCOL_VERSION}`);
  }
  if (!isRecord(result.serverInfo)) fail("initialize returned no serverInfo object");
  if (result.serverInfo.name !== SERVER_NAME) {
    fail(`initialize serverInfo.name must be exactly ${SERVER_NAME}`);
  }
  if (result.serverInfo.version !== EXPECTED_SERVER_VERSION) {
    fail(`initialize serverInfo.version must be exactly ${EXPECTED_SERVER_VERSION}`);
  }
  if (!isRecord(result.capabilities)) fail("initialize returned no capabilities object");
  for (const name of ["tools", "resources", "prompts"]) {
    const capability = result.capabilities[name];
    if (!isRecord(capability) || capability.listChanged !== false) {
      fail(`initialize capability ${name}.listChanged must be exactly false`);
    }
  }
}

function assertFreshRegistryHealth(structuredHealth) {
  if (
    !isRecord(structuredHealth) ||
    structuredHealth.status !== "healthy" ||
    structuredHealth.network !== "mainnet" ||
    structuredHealth.anyStale !== false ||
    !isRecord(structuredHealth.indexer)
  ) {
    fail("get_registry_health returned invalid or stale structured health data");
  }
  for (const name of ["identity", "reputation", "validation"]) {
    const indexer = structuredHealth.indexer[name];
    if (
      !isRecord(indexer) ||
      !Number.isSafeInteger(indexer.lastLedger) ||
      indexer.lastLedger <= 0 ||
      indexer.stale !== false
    ) {
      fail(`get_registry_health returned invalid or stale ${name} indexer data`);
    }
  }
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
      clientInfo: { name: `stellar-agent-market-canary-${options.label}`, version: "1.0.0" },
    },
  });
  assertInitializeResult(initialized.payload);
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
  const result = toolCall.payload?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    fail("get_registry_health returned no result");
  }
  if (result.isError === true || result.error != null) {
    fail("get_registry_health returned a tool-level error");
  }
  assertFreshRegistryHealth(result.structuredContent);

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    clientLabel: options.label,
    marker,
    versionId: options.versionId,
    checks: {
      versionOverride: true,
      shallowHealth: true,
      mcpIdentityAndCapabilities: true,
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
