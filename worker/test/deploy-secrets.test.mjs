import { describe, expect, it, vi } from "vitest";
import {
  assertPersistedSecretsAllowed,
  interpretWranglerResult,
  isKnownSensitiveBindingName,
  parseSecretAllowlist,
  parseSecretListOutput,
  validatePersistedSecrets,
} from "../scripts/validate-persisted-secrets.mjs";

const EMPTY_ALLOWLIST = JSON.stringify({
  worker: "stellar-agent-search",
  allowedSecretNames: [],
});

describe("persisted Cloudflare secret deployment gate", () => {
  it("accepts Wrangler's exact JSON-array output and an empty secret set", () => {
    expect(parseSecretListOutput("[]\n")).toEqual([]);
    expect(assertPersistedSecretsAllowed([], parseSecretAllowlist(EMPTY_ALLOWLIST))).toEqual({
      persisted: 0,
      allowed: 0,
    });
  });

  it("accepts only explicitly allowlisted, reviewed-safe names", () => {
    const names = parseSecretListOutput(
      JSON.stringify([{ name: "ERROR_REPORTING_DSN", type: "secret_text" }]),
    );
    const allowed = parseSecretAllowlist(
      JSON.stringify({
        worker: "stellar-agent-search",
        allowedSecretNames: ["ERROR_REPORTING_DSN"],
      }),
    );
    expect(assertPersistedSecretsAllowed(names, allowed)).toEqual({ persisted: 1, allowed: 1 });
  });

  it("rejects an unexpected persisted secret and known-sensitive allowlist entries", () => {
    expect(() =>
      assertPersistedSecretsAllowed(["UNREVIEWED_VALUE"], parseSecretAllowlist(EMPTY_ALLOWLIST)),
    ).toThrow(/not approved/);
    expect(() =>
      parseSecretAllowlist(
        JSON.stringify({
          worker: "stellar-agent-search",
          allowedSecretNames: ["SUPABASE_SERVICE_ROLE_KEY"],
        }),
      ),
    ).toThrow(/known-sensitive/);
    expect(isKnownSensitiveBindingName("CLOUDFLARE_API_TOKEN")).toBe(true);
    expect(isKnownSensitiveBindingName("STELLAR8004_API")).toBe(false);
  });

  it("fails closed on noisy, malformed, duplicate, or changed Wrangler output", () => {
    expect(() => parseSecretListOutput("wrangler banner\n[]")).toThrow(/not one JSON array/);
    expect(() => parseSecretListOutput("{}")).toThrow(/JSON array/);
    expect(() =>
      parseSecretListOutput(JSON.stringify([{ name: "A", type: "secret_text", value: "leak" }])),
    ).toThrow(/unreviewed schema/);
    expect(() =>
      parseSecretListOutput(
        JSON.stringify([
          { name: "A", type: "secret_text" },
          { name: "A", type: "secret_text" },
        ]),
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      parseSecretListOutput(JSON.stringify([{ name: "A", type: "future_secret" }])),
    ).toThrow(/unreviewed secret type/);
  });

  it("blocks all command failures except an exact, explicitly acknowledged first-deploy 404", () => {
    const absent = {
      status: 1,
      stdout: "",
      stderr: 'Worker "stellar-agent-search" not found.\n\nIf this is a new Worker, run `wrangler deploy` first.',
    };
    expect(() => interpretWranglerResult(absent)).toThrow(/state is unknown/);
    expect(interpretWranglerResult(absent, { allowMissingWorker: true })).toEqual({
      missingWorker: true,
      secretNames: [],
    });
    expect(() =>
      interpretWranglerResult(
        { status: 1, stdout: "", stderr: "Authentication failed" },
        { allowMissingWorker: true },
      ),
    ).toThrow(/reason other than/);
    expect(() => interpretWranglerResult({ status: null, stdout: "", stderr: "timeout" })).toThrow(
      /state is unknown/,
    );
  });

  it("invokes Wrangler with JSON output, exact name/config, and a bounded timeout", async () => {
    const run = vi.fn(() => ({ status: 0, stdout: "[]", stderr: "" }));
    await expect(validatePersistedSecrets({ run })).resolves.toMatchObject({
      persisted: 0,
      allowed: 0,
      missingWorker: false,
    });
    expect(run).toHaveBeenCalledOnce();
    const [command, args, options] = run.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(
      expect.arrayContaining([
        "secret",
        "list",
        "--name",
        "stellar-agent-search",
        "--format",
        "json",
      ]),
    );
    expect(args[args.indexOf("--config") + 1]).toMatch(/worker\/wrangler\.jsonc$/);
    expect(options).toMatchObject({ encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  });
});
