import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STELLAR_PUBNET_CAIP2, USDC_PUBNET_ADDRESS } from "@x402/stellar";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import {
  Account,
  Address,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
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
  credentialFreeChildUrl,
  expectedScrapeUrl,
  loadConfig,
  isSuccessfulResult,
  paymentAuthorizationHash,
  pickScrapper,
  readPaidResult,
  redactSensitiveError,
  requireMcpStructuredContent,
  resolveEndpoint,
  scrapeInit,
  submitFeedbackTransaction,
  submitSignedPaymentRequest,
  validatePaymentChallenge,
  validateSettlementResponse,
  type FeedbackTransactionLike,
  type PaymentAttemptContext,
  type ResolvedAgent,
  type RunJournalEntry,
  type RunRecord,
} from "../examples/x402-demo.js";

const OTHER_ACCOUNT = "GAAIBWG3M3U6PAS3IC5BATPT52XKNYXBRJXQIPHEDQUQIEFQDYH4KZY7";
const ENDPOINT = SCRAPPER_ALLOWED_ENDPOINTS[0];
const TX = "ab".repeat(32);
const RESULT_HASH = "cd".repeat(32);

function paymentEnvelope(nonce = 1n) {
  const args = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(USDC_PUBNET_ADDRESS).toScAddress(),
    functionName: "transfer",
    args: [
      nativeToScVal(OTHER_ACCOUNT, { type: "address" }),
      nativeToScVal(SCRAPPER_EXPECTED_PAY_TO, { type: "address" }),
      nativeToScVal(1000n, { type: "i128" }),
    ],
  });
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(OTHER_ACCOUNT).toScAddress(),
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger: 1_000,
        signature: nativeToScVal(Buffer.from(`sig-${nonce}`)),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(args),
      subInvocations: [],
    }),
  });
  return new TransactionBuilder(new Account(SCRAPPER_EXPECTED_PAY_TO, "0"), {
    fee: "100",
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(args),
        auth: [auth],
      }),
    )
    .setTimeout(30)
    .build();
}

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

function paymentAttempt(): PaymentAttemptContext {
  return {
    startedAt: "2026-07-29T00:00:00.000Z",
    payerPublicKey: OTHER_ACCOUNT,
    agentId: SCRAPPER_AGENT_ID,
    endpoint: ENDPOINT,
    challengeNetwork: STELLAR_PUBNET_CAIP2,
    asset: USDC_PUBNET_ADDRESS,
    payTo: SCRAPPER_EXPECTED_PAY_TO,
    price: "1000",
  };
}

function fakeFeedbackTransaction(status: string, sendError?: Error): FeedbackTransactionLike {
  const transaction: FeedbackTransactionLike = {
    async sign() {
      transaction.signed = { hash: () => Buffer.from(TX, "hex") };
    },
    async send() {
      if (sendError) throw sendError;
      return {
        sendTransactionResponse: { hash: TX },
        getTransactionResponse: { status, txHash: TX },
      };
    },
  };
  return transaction;
}

describe("x402 demo MCP discovery is fail-closed", () => {
  it("never forwards credential-bearing URL configuration to the keyless MCP child", () => {
    expect(credentialFreeChildUrl("HTTPS_PROXY", "http://proxy.example:8080")).toBe(
      "http://proxy.example:8080",
    );
    expect(() => credentialFreeChildUrl("HTTPS_PROXY", "http://user:token@proxy.example:8080")).toThrow(
      /refusing to forward/,
    );
    expect(() => credentialFreeChildUrl("EXPLORER_BASE_URL", "https://example.com?apiKey=secret")).toThrow(
      /refusing to forward/,
    );
  });

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

    // This is the exact scheme mismatch returned by the live deployment on
    // 2026-07-29. It is an upstream blocker, never a reason to weaken the pin.
    required.resource.url = "http://scrapper.stellar8004.com/task";
    expect(() => validatePaymentChallenge(config(false), required)).toThrow(
      /resource mismatch.*http:\/\/scrapper.*expected=https:\/\/scrapper/,
    );
  });

  it("rejects malformed price limits rather than silently using a default", () => {
    expect(() => loadConfig({ MAX_PRICE_USDC: "not-a-number" })).toThrow(/MAX_PRICE_USDC must be/);
    expect(() => validatePaymentChallenge({ ...config(false), maxPriceUsdc: 0.00000001 }, challenge())).toThrow(
      /at most 7 decimals/,
    );
  });
});

describe("x402 one-shot submission state machines", () => {
  it("blocks redirects before a signed header can leak to another origin", async () => {
    const unsigned = scrapeInit(config(false));
    const signed = scrapeInit(config(false), { "payment-signature": "signed-capability" });
    expect(unsigned.redirect).toBe("error");
    expect(signed.redirect).toBe("error");

    const crossOriginHeaders: string[] = [];
    const redirectingFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      // Model fetch's redirect branch: the capability reaches the second
      // origin only if the caller allowed redirect following.
      if (init?.redirect !== "error") {
        const value = new Headers(init?.headers).get("payment-signature");
        if (value) crossOriginHeaders.push(value);
        return new Response("redirected", { status: 200 });
      }
      throw new TypeError("redirect mode is set to error");
    };

    await expect(redirectingFetch(ENDPOINT, signed)).rejects.toThrow(/redirect mode/);
    expect(crossOriginHeaders).toEqual([]);
  });

  it("fsync-seams the payment-submitted record before its only fetch attempt", async () => {
    const entries: RunJournalEntry[] = [];
    let fetchCalls = 0;
    const result = await submitSignedPaymentRequest(
      ENDPOINT,
      scrapeInit(config(false), { "payment-signature": "signed-capability" }),
      RESULT_HASH,
      paymentAttempt(),
      {
        nowMs: () => 1_700_000_000_000,
        appendJournal: async (_startedAt, entry) => {
          entries.push(entry);
          return "/tmp/payment.journal.jsonl";
        },
        fetchImpl: async (_input, init) => {
          fetchCalls += 1;
          expect(entries.map((entry) => entry.event)).toEqual(["payment_submitted"]);
          expect(init?.redirect).toBe("error");
          return new Response("ok", { status: 200 });
        },
      },
    );

    expect(fetchCalls).toBe(1);
    expect(result.journalPath).toBe("/tmp/payment.journal.jsonl");
    expect(entries.map((entry) => entry.event)).toEqual([
      "payment_submitted",
      "payment_response_received",
    ]);
  });

  it("records an unknown payment outcome after a submitted request loses its response", async () => {
    const entries: RunJournalEntry[] = [];
    let fetchCalls = 0;
    await expect(
      submitSignedPaymentRequest(ENDPOINT, scrapeInit(config(false)), RESULT_HASH, paymentAttempt(), {
        appendJournal: async (_startedAt, entry) => {
          entries.push(entry);
          return "/tmp/payment.journal.jsonl";
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("socket reset");
        },
      }),
    ).rejects.toThrow(/PAYMENT_OUTCOME_UNKNOWN.*\/tmp\/payment\.journal\.jsonl.*DO NOT rerun/s);
    expect(fetchCalls).toBe(1);
    expect(entries.map((entry) => entry.event)).toEqual([
      "payment_submitted",
      "payment_outcome_unknown",
    ]);
  });

  it("bounds a hanging signed request and routes abort through the unknown-outcome journal", async () => {
    const entries: RunJournalEntry[] = [];
    await expect(
      submitSignedPaymentRequest(ENDPOINT, scrapeInit(config(false)), RESULT_HASH, paymentAttempt(), {
        requestTimeoutMs: 10,
        appendJournal: async (_startedAt, entry) => {
          entries.push(entry);
          return "/tmp/payment-timeout.journal.jsonl";
        },
        fetchImpl: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            expect(signal).toBeDefined();
            const rejectFromAbort = () => reject(signal?.reason ?? new Error("aborted"));
            if (signal?.aborted) rejectFromAbort();
            else signal?.addEventListener("abort", rejectFromAbort, { once: true });
          }),
      }),
    ).rejects.toThrow(/PAYMENT_OUTCOME_UNKNOWN.*payment-timeout\.journal\.jsonl.*DO NOT rerun/s);
    expect(entries.map((entry) => entry.event)).toEqual([
      "payment_submitted",
      "payment_outcome_unknown",
    ]);
    expect(entries[1]).toMatchObject({ event: "payment_outcome_unknown", stage: "signed_request" });
  });

  it("never submits payment if the durable pre-submit journal fails", async () => {
    let fetchCalls = 0;
    await expect(
      submitSignedPaymentRequest(ENDPOINT, scrapeInit(config(false)), RESULT_HASH, paymentAttempt(), {
        appendJournal: async () => {
          throw new Error("disk full");
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response("unexpected");
        },
      }),
    ).rejects.toThrow(/journal could not be durably created; refusing to submit/);
    expect(fetchCalls).toBe(0);
  });

  it("confirms feedback only after the exact signed hash reaches SUCCESS", async () => {
    const entries: RunJournalEntry[] = [];
    const result = await submitFeedbackTransaction(
      fakeFeedbackTransaction("SUCCESS"),
      paymentAttempt().startedAt,
      SCRAPPER_AGENT_ID,
      {
        appendJournal: async (_startedAt, entry) => {
          entries.push(entry);
          return "/tmp/feedback.journal.jsonl";
        },
      },
    );
    expect(result.feedbackTxHash).toBe(TX);
    expect(entries.map((entry) => entry.event)).toEqual([
      "feedback_submitted",
      "feedback_confirmed",
    ]);
  });

  it("journals terminal FAILED feedback without ever claiming confirmation", async () => {
    const entries: RunJournalEntry[] = [];
    await expect(
      submitFeedbackTransaction(fakeFeedbackTransaction("FAILED"), paymentAttempt().startedAt, SCRAPPER_AGENT_ID, {
        appendJournal: async (_startedAt, entry) => {
          entries.push(entry);
          return "/tmp/feedback.journal.jsonl";
        },
      }),
    ).rejects.toThrow(new RegExp(`FEEDBACK_FAILED: tx=${TX}`));
    expect(entries.map((entry) => entry.event)).toEqual([
      "feedback_submitted",
      "feedback_failed",
    ]);
    expect(entries.some((entry) => entry.event === "feedback_confirmed")).toBe(false);
  });

  it.each([
    ["NOT_FOUND", undefined],
    ["send exception", new Error("poll timed out")],
  ])("classifies %s as unknown with the same recoverable feedback hash", async (status, sendError) => {
    const entries: RunJournalEntry[] = [];
    const transaction = fakeFeedbackTransaction(status === "send exception" ? "NOT_FOUND" : status, sendError);
    await expect(
      submitFeedbackTransaction(transaction, paymentAttempt().startedAt, SCRAPPER_AGENT_ID, {
        appendJournal: async (_startedAt, entry) => {
          entries.push(entry);
          return "/tmp/feedback.journal.jsonl";
        },
      }),
    ).rejects.toThrow(new RegExp(`FEEDBACK_OUTCOME_UNKNOWN: tx=${TX}.*reconcile that exact hash`, "s"));
    expect(entries.map((entry) => entry.event)).toEqual([
      "feedback_submitted",
      "feedback_outcome_unknown",
    ]);
    expect(entries.some((entry) => entry.event === "feedback_confirmed")).toBe(false);
  });
});

describe("x402 evidence integrity", () => {
  it("redacts signer/facilitator secrets and credential-bearing RPC URLs from nested errors", () => {
    const env = {
      STELLAR_PRIVATE_KEY: "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      X402_API_KEY: "x402-super-secret",
      STELLAR_RPC_URL: "https://rpc.example/v1/provider-secret?token=query-secret",
    };
    const message = redactSensitiveError(
      new Error(
        `RPC ${env.STELLAR_RPC_URL} rejected signer ${env.STELLAR_PRIVATE_KEY} using ${env.X402_API_KEY}`,
      ),
      env,
    );
    expect(message).not.toContain("provider-secret");
    expect(message).not.toContain("query-secret");
    expect(message).not.toContain(env.STELLAR_PRIVATE_KEY);
    expect(message).not.toContain(env.X402_API_KEY);
    expect(message.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

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
    const envelope = paymentEnvelope(1n);
    const authorizationHash = paymentAuthorizationHash(envelope.toXDR(), Networks.PUBLIC);
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
      envelopeXdr: envelope.toEnvelope(),
      events: { contractEventsXdr: [[transfer]] },
    };
    const expected = {
      payer: OTHER_ACCOUNT,
      payTo: SCRAPPER_EXPECTED_PAY_TO,
      asset: USDC_PUBNET_ADDRESS,
      amount: "1000",
      submittedAtMs,
      authorizationHash,
      networkPassphrase: Networks.PUBLIC,
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

  it("rejects a prior identical transfer in the same RPC second unless its signed authorization matches", () => {
    const expectedEnvelope = paymentEnvelope(1n);
    const priorEnvelope = paymentEnvelope(2n);
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
    const submittedAtMs = 1_700_000_000_999;
    const priorSameSecond = {
      status: "SUCCESS",
      txHash: TX,
      ledger: 122,
      createdAt: 1_700_000_000,
      envelopeXdr: priorEnvelope.toEnvelope(),
      events: { contractEventsXdr: [[transfer]] },
    };
    expect(() =>
      assertOnchainSettlement(priorSameSecond, TX, {
        payer: OTHER_ACCOUNT,
        payTo: SCRAPPER_EXPECTED_PAY_TO,
        asset: USDC_PUBNET_ADDRESS,
        amount: "1000",
        submittedAtMs,
        authorizationHash: paymentAuthorizationHash(expectedEnvelope.toXDR(), Networks.PUBLIC),
        networkPassphrase: Networks.PUBLIC,
      }),
    ).toThrow(/does not contain this payment's signed Soroban authorization/);
  });

  it("binds the same Soroban authorization across facilitator rebuilds and fee bumps", () => {
    const inner = paymentEnvelope(7n);
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      OTHER_ACCOUNT,
      "100",
      inner,
      Networks.PUBLIC,
    );
    expect(paymentAuthorizationHash(feeBump.toXDR(), Networks.PUBLIC)).toBe(
      paymentAuthorizationHash(inner.toXDR(), Networks.PUBLIC),
    );
    expect(paymentAuthorizationHash(paymentEnvelope(8n).toXDR(), Networks.PUBLIC)).not.toBe(
      paymentAuthorizationHash(inner.toXDR(), Networks.PUBLIC),
    );
  });

  it("admits only the deployed Scrapper's terminal success envelope and output format", () => {
    const output = "URL: https://example.com\nTitle: Example\n\nContent:\nHello";
    expect(isSuccessfulResult({ success: true, data: output }, "https://example.com")).toBe(true);
    expect(isSuccessfulResult({ success: true, data: output }, "https://other.example")).toBe(false);

    expect(isSuccessfulResult({ success: false, data: output })).toBe(false);
    expect(isSuccessfulResult({ success: true, data: "job-1", status: "pending" })).toBe(false);
    expect(isSuccessfulResult({ success: true, data: output, status: "queued" })).toBe(false);
    expect(isSuccessfulResult({ success: true, data: output, code: 200 })).toBe(false);
    expect(isSuccessfulResult({ code: 500, data: ["error"] })).toBe(false);
    expect(isSuccessfulResult({ ok: true, data: [1] })).toBe(false);
    expect(isSuccessfulResult({ arbitrary: "non-empty" })).toBe(false);
    expect(isSuccessfulResult(["not a Scrapper envelope"])).toBe(false);
    expect(isSuccessfulResult({ success: true, data: "URL: https://example.com\nno content section" })).toBe(false);
  });

  it("pins a valid Scrapper request before payment", () => {
    expect(expectedScrapeUrl(config(false))).toBe("https://example.com");
    expect(() => expectedScrapeUrl({ ...config(false), scrapeMethod: "GET" })).toThrow(/requires POST/);
    expect(() => expectedScrapeUrl({ ...config(false), scrapeBody: "not-json" })).toThrow(/must be valid JSON/);
    expect(() =>
      expectedScrapeUrl({
        ...config(false),
        scrapeBody: JSON.stringify({ url: "https://example.com", evaluationMode: true }),
      }),
    ).toThrow(/evaluationMode/);
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
      paymentAuthorizationHash: "12".repeat(32),
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
    expect(() => assertCompleteEvidenceRecord({ ...rec, paymentAuthorizationHash: "" })).toThrow(
      /lowercase SHA-256/,
    );
    expect(() => assertCompleteEvidenceRecord({ ...rec, payerPublicKey: null })).toThrow(/payerPublicKey/);
    expect(() => assertCompleteEvidenceRecord({ ...rec, resultOk: false })).toThrow(/not usable/);
    expect(() => assertCompleteEvidenceRecord({ ...rec, feedbackTxHash: "" })).toThrow(/feedbackTxHash/);
    expect(() => assertCompleteEvidenceRecord({ ...rec, feedbackTxHash: TX })).toThrow(/two distinct transactions/);
  });
});
