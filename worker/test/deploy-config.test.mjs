import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parseDeployConfig,
  stripJsonComments,
  validateDeployConfig,
} from "../scripts/validate-deploy-config.mjs";

const configSource = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");

function deployableConfig() {
  const config = parseDeployConfig(configSource);
  const limiter = config.ratelimits.find((entry) => entry.name === "MCP_RATE_LIMITER");
  limiter.namespace_id = "8675309";
  return config;
}

describe("fail-closed Worker deploy config validation", () => {
  it("parses comments but preserves comment markers inside JSON strings", () => {
    const source = '{ // line\n "url": "https://example.test/a//b", /* block */ "ok": true }';
    expect(JSON.parse(stripJsonComments(source))).toEqual({
      url: "https://example.test/a//b",
      ok: true,
    });
    expect(() => stripJsonComments("{/* never closes")).toThrow(/unterminated block comment/);
  });

  it("accepts the exact deployment topology after the namespace sentinel is replaced", () => {
    expect(validateDeployConfig(deployableConfig())).toMatchObject({
      namespaceId: "8675309",
      rateLimit: 30,
      ratePeriod: 60,
      routes: [
        "https://mcp.stellar8004.com/healthz",
        "https://mcp.stellar8004.com/mcp",
      ],
    });
  });

  it.each(["0", "", "01", "-1", "abc", 42, undefined])(
    "rejects an unsafe or malformed limiter namespace (%s)",
    (namespaceId) => {
      const config = deployableConfig();
      config.ratelimits[0].namespace_id = namespaceId;
      expect(() => validateDeployConfig(config)).toThrow(/namespace_id must be a non-zero/);
    },
  );

  it("rejects missing and duplicate limiter bindings", () => {
    const missing = deployableConfig();
    missing.ratelimits = [];
    expect(() => validateDeployConfig(missing)).toThrow(/configured exactly once/);

    const duplicate = deployableConfig();
    duplicate.ratelimits.push({ ...duplicate.ratelimits[0] });
    expect(() => validateDeployConfig(duplicate)).toThrow(/configured exactly once/);
  });

  it("rejects broadened routes and public preview endpoints", () => {
    const broad = deployableConfig();
    broad.routes[0].pattern = "https://mcp.stellar8004.com/*";
    expect(() => validateDeployConfig(broad)).toThrow(/approved exact HTTPS route/);

    const publicPreview = deployableConfig();
    publicPreview.workers_dev = true;
    expect(() => validateDeployConfig(publicPreview)).toThrow(/workers_dev must be explicitly false/);
  });

  it("requires version metadata so an override canary proves the served version", () => {
    const config = deployableConfig();
    delete config.version_metadata;
    expect(() => validateDeployConfig(config)).toThrow(/version_metadata/);
  });

  it("rejects the wrong service target or an axios-capable Stellar SDK alias", () => {
    const wrongService = deployableConfig();
    wrongService.services[0].service = "public-indexer-copy";
    expect(() => validateDeployConfig(wrongService)).toThrow(/bind exactly once/);

    const axios = deployableConfig();
    axios.alias["@stellar/stellar-sdk"] = "@stellar/stellar-sdk";
    expect(() => validateDeployConfig(axios)).toThrow(/no-axios/);
  });
});
