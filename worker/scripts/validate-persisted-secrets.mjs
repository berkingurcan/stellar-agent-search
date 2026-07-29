import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WORKER_NAME = "stellar-agent-mcp";

const SAFE_BINDING_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_TYPES = new Set(["secret_text", "secret_key"]);
const KNOWN_SENSITIVE_NAMES = new Set([
  "DATABASE_URL",
  "DIRECT_URL",
  "POSTGRES_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STELLAR_PRIVATE_KEY",
  "STELLAR_SECRET_KEY",
]);
const SENSITIVE_NAME_PART = /(?:^|_)(?:API_KEY|AUTH_TOKEN|BEARER_TOKEN|CLIENT_SECRET|CREDENTIALS?|KEY|MNEMONIC|PASSWORD|PRIVATE_KEY|REFRESH_TOKEN|SECRET|SEED|TOKEN)(?:_|$)/;

function gateError(message) {
  throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isKnownSensitiveBindingName(name) {
  return (
    KNOWN_SENSITIVE_NAMES.has(name) ||
    /^SUPABASE(?:_|$)/.test(name) ||
    /^(?:DATABASE|POSTGRES|PG)(?:_|$)/.test(name) ||
    SENSITIVE_NAME_PART.test(name)
  );
}

export function parseSecretListOutput(stdout) {
  const source = stdout.trim();
  if (source.length === 0) gateError("wrangler secret list returned no JSON output");

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    gateError("wrangler secret list output was not one JSON array");
  }
  if (!Array.isArray(parsed)) gateError("wrangler secret list output must be a JSON array");

  const names = [];
  const seen = new Set();
  for (const [index, entry] of parsed.entries()) {
    if (!isRecord(entry)) gateError(`secret list entry ${index} must be an object`);
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "name" || keys[1] !== "type") {
      gateError(`secret list entry ${index} has an unreviewed schema`);
    }
    if (typeof entry.name !== "string" || !SAFE_BINDING_NAME.test(entry.name)) {
      gateError(`secret list entry ${index} has an invalid binding name`);
    }
    if (typeof entry.type !== "string" || !SECRET_TYPES.has(entry.type)) {
      gateError(`secret list entry ${index} has an unreviewed secret type`);
    }
    if (seen.has(entry.name)) gateError(`secret list contains duplicate binding ${entry.name}`);
    seen.add(entry.name);
    names.push(entry.name);
  }
  return names.sort();
}

export function parseSecretAllowlist(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    gateError("deploy secret allowlist is not valid JSON");
  }
  if (!isRecord(parsed)) gateError("deploy secret allowlist must be an object");
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "allowedSecretNames" || keys[1] !== "worker") {
    gateError("deploy secret allowlist has an unreviewed schema");
  }
  if (parsed.worker !== WORKER_NAME) {
    gateError(`deploy secret allowlist must target ${WORKER_NAME}`);
  }
  if (!Array.isArray(parsed.allowedSecretNames)) {
    gateError("allowedSecretNames must be an array");
  }

  const allowed = new Set();
  for (const [index, value] of parsed.allowedSecretNames.entries()) {
    if (typeof value !== "string" || !SAFE_BINDING_NAME.test(value)) {
      gateError(`allowedSecretNames[${index}] is not a valid binding name`);
    }
    if (isKnownSensitiveBindingName(value)) {
      gateError(`allowedSecretNames may not permit known-sensitive binding ${value}`);
    }
    if (allowed.has(value)) gateError(`allowedSecretNames contains duplicate ${value}`);
    allowed.add(value);
  }
  return allowed;
}

export function assertPersistedSecretsAllowed(secretNames, allowedNames) {
  const unexpected = secretNames.filter((name) => !allowedNames.has(name));
  if (unexpected.length > 0) {
    gateError(
      `persisted Cloudflare secrets are not approved for this keyless Worker: ${unexpected.join(", ")}`,
    );
  }
  return { persisted: secretNames.length, allowed: allowedNames.size };
}

function exactMissingWorker(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const escapedName = WORKER_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`Worker "${escapedName}"(?: \\(env: [^)]+\\))? not found\\.`).test(output);
}

export function interpretWranglerResult(result, { allowMissingWorker = false } = {}) {
  if (result.error) gateError("wrangler secret list could not be executed");
  if (result.status !== 0) {
    if (allowMissingWorker && exactMissingWorker(result)) {
      return { missingWorker: true, secretNames: [] };
    }
    gateError(
      allowMissingWorker
        ? "wrangler secret list failed for a reason other than an absent first-deploy Worker"
        : "wrangler secret list failed; persisted secret state is unknown",
    );
  }
  return { missingWorker: false, secretNames: parseSecretListOutput(result.stdout ?? "") };
}

export async function validatePersistedSecrets({
  configPath,
  allowlistPath,
  allowMissingWorker = false,
  run = spawnSync,
} = {}) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const workerDir = resolve(scriptDir, "..");
  const resolvedConfig = resolve(workerDir, configPath ?? "wrangler.jsonc");
  const resolvedAllowlist = resolve(workerDir, allowlistPath ?? "deploy-secret-allowlist.json");
  const allowlist = parseSecretAllowlist(await readFile(resolvedAllowlist, "utf8"));
  const wranglerBin = resolve(workerDir, "..", "node_modules", "wrangler", "bin", "wrangler.js");
  const result = run(
    process.execPath,
    [
      wranglerBin,
      "secret",
      "list",
      "--name",
      WORKER_NAME,
      "--config",
      resolvedConfig,
      "--format",
      "json",
    ],
    {
      cwd: workerDir,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
      },
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    },
  );
  const interpreted = interpretWranglerResult(result, { allowMissingWorker });
  const counts = assertPersistedSecretsAllowed(interpreted.secretNames, allowlist);
  return { ...counts, missingWorker: interpreted.missingWorker };
}

function parseArgs(argv) {
  const options = { allowMissingWorker: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--allow-missing-worker") {
      options.allowMissingWorker = true;
    } else if (arg === "--config" || arg === "--allowlist") {
      const value = argv[++index];
      if (!value) gateError(`${arg} requires a path`);
      if (arg === "--config") options.configPath = value;
      else options.allowlistPath = value;
    } else {
      gateError(`unknown argument ${arg}`);
    }
  }
  return options;
}

async function main() {
  try {
    const result = await validatePersistedSecrets(parseArgs(process.argv.slice(2)));
    if (result.missingWorker) {
      console.log("Persisted-secret gate valid: explicit first-deploy mode confirmed no existing Worker.");
    } else {
      console.log(
        `Persisted-secret gate valid: ${result.persisted} remote secret(s), ${result.allowed} explicitly allowed.`,
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown validation error";
    console.error(`DEPLOY BLOCKED: ${detail}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
