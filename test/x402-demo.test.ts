import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STELLAR_PUBNET_CAIP2, USDC_PUBNET_ADDRESS } from "@x402/stellar";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import {
  SCRAPPER_AGENT_ID,
  SCRAPPER_ALLOWED_ENDPOINTS,
  SCRAPPER_EXPECTED_PAY_TO,
  SCRAPPER_OWNER,
  assertCompleteEvidenceRecord,
  assertEvidenceTarget,
  assertOnchainSettlement,
  assertResultHash,
  assertTransactionHash,
  loadConfig,
  isSuccessfulResult,
  pickScrapper,
  readPaidResult,
  requireMcpStructuredContent,
  resolveEndpoint,
  validatePaymentChallenge,
  validateSettlementResponse,
  type ResolvedAgent,
  type RunRecord,
} from "../examples/x402-demo.js";

const OTHER_ACCOUNT = "GAAIBWG3M3U6PAS3IC5BATPT52XKNYXBRJXQIPHEDQUQIEFQDYH4KZY7";
const ENDPOINT = SCRAPPER_ALLOWED_ENDPOINTS[0];
const TX = "ab".repeat(32);
const RESULT_HASH = "cd".repeat(32);

function config(dryRun = true) {
  return loadConfig({ STELLAR_NETWORK: "mainnet", DRY_RUN: dryRun ? "1" : "0" });
}

function agent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    agentId: SCRAPPER_AGENT_ID,
    name: "Scrapper",
    endpoint: ENDPOINT,
    wallet: SCRAPPER_EXPECTED_PAY_TO,
    owner: SCRAPPER_OWNER,
    x402Enabled: true,
    ...overrides,
  };
}

function challenge(overrides: Record<string, unknown> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: ENDPOINT, description: "scrape", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: STELLAR_PUBNET_CAIP2,
        asset: USDC_PUBNET_ADDRESS,
        amount: "1000",
        payTo: SCRAPPER_EXPECTED_PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
        ...overrides,
      },
    ],
  } as PaymentRequired;
}

describe("x402 demo MCP discovery is fail-closed", () => {
  it("rejects MCP tool-level errors even when the transport returned normally", () => {
    expect(() =>
      requireMcpStructuredContent("find_agent", {
        isError: true,
        content: [{ type: "text", text: '{"code":"UPSTREAM_ERROR"}' }],
      }),
    ).toThrow(/MCP tool failed.*UPSTREAM_ERROR/);
  });

  it("requires object structuredContent", () => {
    expect(() => requireMcpStructuredContent("find_agent", { content: [] })).toThrow(/missing object structuredContent/);
    expect(requireMcpStructuredContent("find_agent", { structuredContent: { agents: [] } })).toEqual({ agents: [] });
  });

  it("never falls back when agent 10 is absent", () => {
    expect(() => pickScrapper([])).toThrow(/non-empty array/);
    expect(() => pickScrapper([{ id: 13 }])).toThrow(/agent 10 was not discovered.*refusing fallback/);
    expect(pickScrapper([{ id: 13 }, { id: SCRAPPER_AGENT_ID }]).id).toBe(SCRAPPER_AGENT_ID);
  });

  it("never invents a service endpoint", () => {
    expect(() => resolveEndpoint({ selfDeclared: { services: [] } })).toThrow(/no HTTPS service endpoint.*fallback/);
    expect(() =>
      resolveEndpoint({ selfDeclared: { services: [{ endpoint: "https://user:pass@example.com/task" }] } }),
    ).toThrow(/invalid service endpoint/);
    expect(resolveEndpoint({ selfDeclared: { services: [{ endpoint: ENDPOINT }] } })).toBe(ENDPOINT);
  });

  it("makes x402 and the pinned identity fatal even in the dry-run gate", () => {
    expect(() => assertEvidenceTarget(config(true), agent({ x402Enabled: false }))).toThrow(/does not advertise x402/);
    expect(() => assertEvidenceTarget(config(true), agent({ owner: OTHER_ACCOUNT }))).toThrow(/owner mismatch/);
    expect(() => assertEvidenceTarget(config(true), agent({ endpoint: "https://evil.example/task" }))).toThrow(
      /not in the evidence allowlist/,
    );
    expect(() => assertEvidenceTarget(config(true), agent())).not.toThrow();
  });
});

describe("x402 challenge policy", () => {
  it("accepts only the pinned exact/pubnet/USDC/payee tuple below the cap", () => {
    const checked = validatePaymentChallenge(config(false), challenge());
    expect(checked.priceUsdc).toBe("0.0001");
    expect(checked.required.accepts).toHaveLength(1);
    expect(checked.requirement.payTo).toBe(SCRAPPER_EXPECTED_PAY_TO);
  });

  it.each([
    ["scheme", { scheme: "upto" }, /scheme mismatch/],
    ["network", { network: "stellar:testnet" }, /network mismatch/],
    ["asset", { asset: "CNOTUSDC" }, /asset mismatch/],
    ["scientific amount", { amount: "1e3" }, /not a base-unit integer/],
    ["zero amount", { amount: "0" }, /greater than zero/],
    ["over cap", { amount: "1000001" }, /exceeds MAX_PRICE_USDC/],
    ["unexpected payee", { payTo: OTHER_ACCOUNT }, /payTo mismatch/],
    ["unbounded timeout", { maxTimeoutSeconds: 3_600 }, /maxTimeoutSeconds/],
    ["unsponsored fee", { extra: { areFeesSponsored: false } }, /areFeesSponsored=true/],
  ])("rejects an untrusted %s field", (_name, override, expected) => {
    expect(() => validatePaymentChallenge(config(false), challenge(override))).toThrow(expected as RegExp);
  });

  it("rejects ambiguity instead of letting the x402 client select an unchecked alternative", () => {
    const required = challenge();
    required.accepts.push({ ...required.accepts[0] });
    expect(() => validatePaymentChallenge(config(false), required)).toThrow(/exactly one payment requirement/);
  });

  it("requires the challenge resource to be the allowlisted endpoint", () => {
    const required = challenge();
    required.resource.url = "https://evil.example/task";
    expect(() => validatePaymentChallenge(config(false), required)).toThrow(/resource mismatch/);
  });

  it("rejects malformed price limits rather than silently using a default", () => {
    expect(() => loadConfig({ MAX_PRICE_USDC: "not-a-number" })).toThrow(/MAX_PRICE_USDC must be/);
    expect(() => validatePaymentChallenge({ ...config(false), maxPriceUsdc: 0.00000001 }, challenge())).toThrow(
      /at most 7 decimals/,
    );
  });
});

describe("x402 evidence integrity", () => {
  it("requires canonical 32-byte transaction and result hashes", () => {
    expect(assertTransactionHash("payment", TX.toUpperCase())).toBe(TX);
    expect(() => assertTransactionHash("payment", "")).toThrow(/missing or not a 32-byte hex hash/);
    expect(assertResultHash(RESULT_HASH)).toBe(RESULT_HASH);
    expect(() => assertResultHash(RESULT_HASH.toUpperCase())).toThrow(/lowercase SHA-256/);
  });

  it("hashes the exact paid response bytes and rejects an empty response", async () => {
    const body = JSON.stringify({ ok: true, data: [1] });
    const parsed = await readPaidResult(new Response(body, { status: 200 }));
    expect(parsed.result).toEqual({ ok: true, data: [1] });
    expect(parsed.resultHash).toBe(createHash("sha256").update(Buffer.from(body)).digest("hex"));
    await expect(readPaidResult(new Response("", { status: 200 }))).rejects.toThrow(/empty response body/);
    await expect(
      readPaidResult(
        new Response("small", { headers: { "content-length": String(1_048_577) } }),
      ),
    ).rejects.toThrow(/exceeds 1048576 bytes/);
    await expect(
      readPaidResult(new Response(new Uint8Array(1_048_577))),
    ).rejects.toThrow(/exceeds 1048576 bytes/);
  });

  it("requires a successful settlement response with the expected payer/network/amount", () => {
    const expected = { payer: OTHER_ACCOUNT, network: STELLAR_PUBNET_CAIP2, amount: "1000" };
    const response = {
      success: true,
      payer: OTHER_ACCOUNT,
      transaction: TX,
      network: STELLAR_PUBNET_CAIP2,
      amount: "1000",
    } as SettleResponse;
    expect(validateSettlementResponse(response, expected)).toBe(TX);
    expect(() => validateSettlementResponse({ ...response, success: false }, expected)).toThrow(
      /reported failure/,
    );
    expect(() => validateSettlementResponse({ ...response, payer: SCRAPPER_OWNER }, expected)).toThrow(
      /payer mismatch/,
    );
    expect(() => validateSettlementResponse({ ...response, amount: "999" }, expected)).toThrow(
      /amount mismatch/,
    );
  });

  it("requires a final, fresh on-chain transfer matching the full tuple", () => {
    const submittedAtMs = 1_700_000_000_500;
    const transfer = {
      type: () => ({ name: "contract" }),
      contractId: () => StrKey.decodeContract(USDC_PUBNET_ADDRESS),
      body: () => ({
        v0: () => ({
          topics: () => [
            nativeToScVal("transfer", { type: "symbol" }),
            nativeToScVal(OTHER_ACCOUNT, { type: "address" }),
            nativeToScVal(SCRAPPER_EXPECTED_PAY_TO, { type: "address" }),
          ],
          data: () => nativeToScVal(1000n, { type: "i128" }),
        }),
      }),
    };
    const tx = {
      status: "SUCCESS",
      txHash: TX,
      ledger: 123,
      createdAt: 1_700_000_001,
      events: { contractEventsXdr: [[transfer]] },
    };
    const expected = {
      payer: OTHER_ACCOUNT,
      payTo: SCRAPPER_EXPECTED_PAY_TO,
      asset: USDC_PUBNET_ADDRESS,
      amount: "1000",
      submittedAtMs,
    };
    expect(assertOnchainSettlement(tx, TX, expected)).toEqual({
      ledger: 123,
      confirmedAt: "2023-11-14T22:13:21.000Z",
    });
    expect(() => assertOnchainSettlement({ ...tx, status: "FAILED" }, TX, expected)).toThrow(
      /not final-success/,
    );
    expect(() =>
      assertOnchainSettlement({ ...tx, createdAt: 1_699_999_999 }, TX, expected),
    ).toThrow(/predates/);
    expect(() => assertOnchainSettlement(tx, TX, { ...expected, amount: "1001" })).toThrow(
      /does not match expected/,
    );
  });

  it("never promotes explicit failure objects to successful feedback", () => {
    expect(isSuccessfulResult({ success: false, data: [1] })).toBe(false);
    expect(isSuccessfulResult({ ok: false, data: [1] })).toBe(false);
    expect(isSuccessfulResult({ status: "error", data: [1] })).toBe(false);
    expect(isSuccessfulResult({ ok: true })).toBe(false);
    expect(isSuccessfulResult({ ok: true, data: {} })).toBe(false);
    expect(isSuccessfulResult({ ok: true, data: [1] })).toBe(true);
  });

  it("will not write an incomplete or unsuccessful full evidence receipt", () => {
    const rec: RunRecord = {
      network: "mainnet",
      dryRun: false,
      payerPublicKey: OTHER_ACCOUNT,
      agentId: SCRAPPER_AGENT_ID,
      owner: SCRAPPER_OWNER,
      endpoint: ENDPOINT,
      challengeNetwork: STELLAR_PUBNET_CAIP2,
      asset: USDC_PUBNET_ADDRESS,
      payTo: SCRAPPER_EXPECTED_PAY_TO,
      price: "1000",
      paymentTxHash: TX,
      settlementLedger: 123,
      settlementConfirmedAt: "2026-07-29T00:00:00.500Z",
      resultHash: RESULT_HASH,
      resultOk: true,
      feedbackTxHash: "ef".repeat(32),
      startedAt: "2026-07-29T00:00:00.000Z",
      finishedAt: "2026-07-29T00:00:01.000Z",
      expertLinks: {},
    };
    expect(() => assertCompleteEvidenceRecord(rec)).not.toThrow();
    expect(() => assertCompleteEvidenceRecord({ ...rec, paymentTxHash: "" })).toThrow(/paymentTxHash/);
    expect(() => assertCompleteEvidenceRecord({ ...rec, payerPublicKey: null })).toThrow(/payerPublicKey/);
    expect(() => assertCompleteEvidenceRecord({ ...rec, resultOk: false })).toThrow(/not usable/);
    expect(() => assertCompleteEvidenceRecord({ ...rec, feedbackTxHash: "" })).toThrow(/feedbackTxHash/);
    expect(() => assertCompleteEvidenceRecord({ ...rec, feedbackTxHash: TX })).toThrow(/two distinct transactions/);
  });
});
