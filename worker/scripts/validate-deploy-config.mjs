import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_ROUTES = new Set([
  "https://mcp.stellar8004.com/mcp",
  "https://mcp.stellar8004.com/healthz",
]);
const EXPECTED_RATE_LIMIT = 30;
const EXPECTED_RATE_PERIOD = 60;
const APPROVED_TOP_LEVEL_KEYS = new Set([
  "$schema",
  "compatibility_date",
  "compatibility_flags",
  "main",
  "name",
  "observability",
  "preview_urls",
  "ratelimits",
  "routes",
  "services",
  "vars",
  "version_metadata",
  "workers_dev",
]);

// Optional text vars may only restate the immutable production defaults. The
// Worker does not need overrides in production, but accepting these exact
// values makes an explicit wrangler config equivalent to the defaulted config.
// Everything else (notably funded simulation sources and server identity) is
// derived from the reviewed artifact or rejected.
const APPROVED_VARS = Object.freeze({
  STELLAR_NETWORK: "mainnet",
  EXPLORER_BASE_URL: "https://stellar8004.com",
  VERIFY_ONCHAIN: "true",
  RANK_SCORE_MAX: "100",
});

function deployError(message) {
  throw new Error(message);
}

function objectValue(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    deployError(`${label} must be an object`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    deployError(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * Remove JSONC comments without treating comment markers inside strings as
 * syntax. Comment bytes become spaces so JSON parse offsets remain useful.
 * Deliberately leaves all other JSON syntax untouched and rejects an
 * unterminated block comment; malformed config can never fall through as OK.
 */
export function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        output += char;
      } else {
        output += " ";
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        output += "  ";
        index++;
        blockComment = false;
      } else {
        output += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      output += "  ";
      index++;
      lineComment = true;
    } else if (char === "/" && next === "*") {
      output += "  ";
      index++;
      blockComment = true;
    } else {
      output += char;
    }
  }

  if (blockComment) deployError("wrangler.jsonc contains an unterminated block comment");
  return output;
}

export function parseDeployConfig(source) {
  try {
    return JSON.parse(stripJsonComments(source));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown JSON parse error";
    deployError(`wrangler.jsonc is not valid JSONC: ${detail}`);
  }
}

/**
 * Validate the security-sensitive deployment topology. This is intentionally
 * stricter than Wrangler's schema: a missing/renamed limiter, accidental broad
 * route, public workers.dev endpoint, or unreviewed module alias blocks deploy.
 * Stellar SDK v16's default exports are fetch-based; the dry-run bundle gate
 * separately rejects axios implementation code in the emitted Worker.
 */
export function validateDeployConfig(rawConfig) {
  const config = objectValue(rawConfig, "wrangler config");

  for (const key of Object.keys(config)) {
    if (!APPROVED_TOP_LEVEL_KEYS.has(key)) {
      deployError(`top-level ${key} is not an approved production Worker setting`);
    }
  }

  if (config.name !== "stellar-agent-mcp") deployError("worker name must be stellar-agent-mcp");
  if (config.main !== "src/index.ts") deployError("worker main must be src/index.ts");
  if (config.workers_dev !== false) deployError("workers_dev must be explicitly false");
  if (config.preview_urls !== false) deployError("preview_urls must be explicitly false");
  const versionMetadata = objectValue(config.version_metadata, "version_metadata");
  if (versionMetadata.binding !== "CF_VERSION_METADATA") {
    deployError("version_metadata.binding must be CF_VERSION_METADATA");
  }

  const vars = config.vars === undefined ? {} : objectValue(config.vars, "vars");
  for (const [name, value] of Object.entries(vars)) {
    if (!Object.hasOwn(APPROVED_VARS, name)) {
      deployError(`vars.${name} is not an approved production Worker variable`);
    }
    const expected = APPROVED_VARS[name];
    if (value !== expected) {
      deployError(`vars.${name} must be exactly ${JSON.stringify(expected)}`);
    }
  }

  if (!Array.isArray(config.routes) || config.routes.length !== EXPECTED_ROUTES.size) {
    deployError("routes must contain only the exact /mcp and /healthz HTTPS routes");
  }
  const seenRoutes = new Set();
  for (const [index, rawRoute] of config.routes.entries()) {
    const route = objectValue(rawRoute, `routes[${index}]`);
    if (route.zone_name !== "stellar8004.com") {
      deployError(`routes[${index}].zone_name must be stellar8004.com`);
    }
    if (typeof route.pattern !== "string" || !EXPECTED_ROUTES.has(route.pattern)) {
      deployError(`routes[${index}].pattern is not an approved exact HTTPS route`);
    }
    if (seenRoutes.has(route.pattern)) deployError(`duplicate route ${route.pattern}`);
    seenRoutes.add(route.pattern);
  }

  if (!Array.isArray(config.services) || config.services.length !== 1) {
    deployError("services must contain only the canonical Explorer binding");
  }
  const apiBindings = config.services.filter(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      entry.binding === "STELLAR8004_API",
  );
  if (apiBindings.length !== 1 || apiBindings[0].service !== "stellar8004-web") {
    deployError("STELLAR8004_API must bind exactly once to stellar8004-web");
  }

  if (!Array.isArray(config.ratelimits) || config.ratelimits.length !== 1) {
    deployError("MCP_RATE_LIMITER must be configured exactly once with no other ratelimit binding");
  }
  const limiterBindings = config.ratelimits.filter(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      entry.name === "MCP_RATE_LIMITER",
  );
  if (limiterBindings.length !== 1) {
    deployError("MCP_RATE_LIMITER must be configured exactly once");
  }
  const limiter = limiterBindings[0];
  if (
    typeof limiter.namespace_id !== "string" ||
    !/^[1-9][0-9]*$/.test(limiter.namespace_id)
  ) {
    deployError(
      "MCP_RATE_LIMITER namespace_id must be a non-zero account-unique decimal string (0 is dry-run only)",
    );
  }
  const simple = objectValue(limiter.simple, "MCP_RATE_LIMITER.simple");
  const rateLimit = positiveInteger(simple.limit, "MCP_RATE_LIMITER.simple.limit");
  const ratePeriod = positiveInteger(simple.period, "MCP_RATE_LIMITER.simple.period");
  if (rateLimit !== EXPECTED_RATE_LIMIT || ratePeriod !== EXPECTED_RATE_PERIOD) {
    deployError(
      `MCP_RATE_LIMITER.simple must remain ${EXPECTED_RATE_LIMIT} requests per ${EXPECTED_RATE_PERIOD} seconds`,
    );
  }

  return {
    namespaceId: limiter.namespace_id,
    rateLimit,
    ratePeriod,
    routes: [...seenRoutes].sort(),
  };
}

export async function validateDeployConfigFile(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown read error";
    deployError(`cannot read ${path}: ${detail}`);
  }
  return validateDeployConfig(parseDeployConfig(source));
}

async function main() {
  const path = resolve(process.cwd(), process.argv[2] ?? "wrangler.jsonc");
  try {
    const result = await validateDeployConfigFile(path);
    console.log(
      `Deploy config valid: limiter namespace ${result.namespaceId}, ${result.routes.length} exact routes.`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown validation error";
    console.error(`DEPLOY BLOCKED: ${detail}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
