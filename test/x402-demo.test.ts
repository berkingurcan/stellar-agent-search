import { createHash } from "node:crypto";
import { mkdtemp, readFile as readFsFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  acquireFundedRunLock,
  appendDurableJsonLine,
  assertCompleteEvidenceRecord,
  assertEvidenceTarget,
  assertOnchainFeedback,
  assertOnchainSettlement,
  assertResultHash,
  assertTransactionHash,
  buildFeedbackEvidenceUri,
  canonicalRequestIdentity,
  captureUntrustedSettlementClaim,
  credentialFreeChildUrl,
  expectedScrapeUrl,
  loadConfig,
  isSuccessfulResult,
  paymentAuthorizationHash,
  pickScrapper,
  readPaidResult,
  redactSensitiveError,
  releaseReconciledFundedRunLock,
  requireMcpStructuredContent,
  resolveEndpoint,
  scrapeInit,
  submitFeedbackTransaction,
  submitSignedPaymentRequest,
  transactionEnvelopeHash,
  validatePaymentChallenge,
  validateSettlementResponse,
  writeAtomicJsonFile,
  writePaymentRecoveryArtifact,
  type FeedbackOnchainExpectation,
  type FeedbackTransactionLike,
  type PaymentAttemptContext,
  type ResolvedAgent,
  type RunJournalEntry,
  type RunRecord,
} from "../examples/x402-demo.js";

const OTHER_ACCOUNT = "GAAIBWG3M3U6PAS3IC5BATPT52XKNYXBRJXQIPHEDQUQIEFQDYH4KZY7";
const ENDPOINT = SCRAPPER_ALLOWED_ENDPOINTS[0];
const REPUTATION_CONTRACT = "CBOIAIMMWAXI57OATLX6BWVDQLCC4YU55HV6MZXFRP6CBSGAMXSTEPPA";
const TX = "ab".repeat(32);
const RESULT_HASH = "cd".repeat(32);
const FAKE_FEEDBACK_PROOF = {
  ledger: 456,
  confirmedAt: "2026-07-29T00:00:02.000Z",
  feedbackIndex: "7",
  transactionXdr: "AAAA",
  eventXdr: "AAAA",
};
const TEST_PAYMENT_RECOVERY_REFERENCE = {
  path: "/tmp/payment-recovery.json",
  sha256: "45".repeat(32),
};

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

function feedbackOnchainFixture(overrides: Partial<FeedbackOnchainExpectation> = {}) {
  const feedbackHash = overrides.feedbackHash ?? "67".repeat(32);
  const expected: FeedbackOnchainExpectation = {
    contractId: REPUTATION_CONTRACT,
    caller: OTHER_ACCOUNT,
    agentId: SCRAPPER_AGENT_ID,
    value: 95n,
    valueDecimals: 0,
    tag1: "starred",
    tag2: "successRate",
    endpoint: ENDPOINT,
    feedbackUri: "data:application/json;base64,e30=",
    feedbackHash,
    submittedAtMs: 1_700_000_000_500,
    networkPassphrase: Networks.PUBLIC,
    ...overrides,
  };
  const invocation = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(expected.contractId).toScAddress(),
    functionName: "give_feedback",
    args: [
      nativeToScVal(expected.caller, { type: "address" }),
      nativeToScVal(expected.agentId, { type: "u32" }),
      nativeToScVal(expected.value, { type: "i128" }),
      nativeToScVal(expected.valueDecimals, { type: "u32" }),
      nativeToScVal(expected.tag1, { type: "string" }),
      nativeToScVal(expected.tag2, { type: "string" }),
      nativeToScVal(expected.endpoint, { type: "string" }),
      nativeToScVal(expected.feedbackUri, { type: "string" }),
      nativeToScVal(Buffer.from(expected.feedbackHash, "hex")),
    ],
  });
  const envelope = new TransactionBuilder(new Account(expected.caller, "0"), {
    fee: "100",
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(invocation),
        auth: [],
      }),
    )
    .setTimeout(30)
    .build();
  const data = xdr.ScVal.scvMap(
    [
      ["feedback_index", nativeToScVal(7n, { type: "u64" })],
      ["value", nativeToScVal(expected.value, { type: "i128" })],
      ["value_decimals", nativeToScVal(expected.valueDecimals, { type: "u32" })],
      ["tag2", nativeToScVal(expected.tag2, { type: "string" })],
      ["endpoint", nativeToScVal(expected.endpoint, { type: "string" })],
      ["feedback_uri", nativeToScVal(expected.feedbackUri, { type: "string" })],
      ["feedback_hash", nativeToScVal(Buffer.from(expected.feedbackHash, "hex"))],
    ].map(
      ([key, val]) =>
        new xdr.ScMapEntry({
          key: nativeToScVal(key as string, { type: "symbol" }),
          val: val as xdr.ScVal,
        }),
    ),
  );
  const event = new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: StrKey.decodeContract(expected.contractId) as any,
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: [
          nativeToScVal("new_feedback", { type: "symbol" }),
          nativeToScVal(expected.agentId, { type: "u32" }),
          nativeToScVal(expected.caller, { type: "address" }),
          nativeToScVal(expected.tag1, { type: "string" }),
        ],
        data,
      }),
    ),
  });
  const txHash = transactionEnvelopeHash(envelope.toXDR(), Networks.PUBLIC);
  return {
    expected,
    txHash,
    signedTransactionXdr: envelope.toXDR(),
    transaction: {
      status: "SUCCESS",
      txHash,
      ledger: 456,
      createdAt: 1_700_000_001,
      envelopeXdr: envelope.toEnvelope(),
      events: { contractEventsXdr: [[event]] },
    },
  };
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
  const identity = canonicalRequestIdentity(config(false), OTHER_ACCOUNT, SCRAPPER_AGENT_ID, ENDPOINT);
  return {
    ...identity,
    startedAt: "2026-07-29T00:00:00.000Z",
    endpoint: ENDPOINT,
    challengeNetwork: STELLAR_PUBNET_CAIP2,
    asset: USDC_PUBNET_ADDRESS,
    payTo: SCRAPPER_EXPECTED_PAY_TO,
    price: "1000",
    paymentTransactionXdr: paymentEnvelope().toXDR(),
    signedPaymentPayload: { x402Version: 2, payload: { transaction: "test-only" } },
  };
}

function fakeFeedbackTransaction(status: string, sendError?: Error): FeedbackTransactionLike {
  const transaction: FeedbackTransactionLike = {
    async sign() {
      transaction.signed = {
        hash: () => Buffer.from(TX, "hex"),
        toXDR: () => "signed-feedback-xdr-must-not-be-journaled",
      };
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
    let recoveryArtifactPersisted = false;
    let persistedArtifact: unknown;
    const result = await submitSignedPaymentRequest(
      ENDPOINT,
      scrapeInit(config(false), { "payment-signature": "signed-capability" }),
      RESULT_HASH,
      paymentAttempt(),
      {
        nowMs: () => 1_700_000_000_000,
        persistRecoveryArtifact: async (_startedAt, artifact) => {
          recoveryArtifactPersisted = true;
          persistedArtifact = artifact;
          return TEST_PAYMENT_RECOVERY_REFERENCE;
        },
        appendJournal: async (_startedAt, entry) => {
          expect(recoveryArtifactPersisted).toBe(true);
          entries.push(entry);
          return "/tmp/payment.journal.jsonl";
        },
        fetchImpl: async (_input, init) => {
          fetchCalls += 1;
          expect(entries.map((entry) => entry.event)).toEqual(["payment_submission_prepared"]);
          expect(init?.redirect).toBe("error");
          return new Response("ok", { status: 200 });
        },
      },
    );

    expect(fetchCalls).toBe(1);
    expect(result.journalPath).toBe("/tmp/payment.journal.jsonl");
    expect(entries.map((entry) => entry.event)).toEqual([
      "payment_submission_prepared",
      "payment_response_received",
    ]);
    expect(entries[0]).toMatchObject({
      event: "payment_submission_prepared",
      paymentTransactionXdrSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      signedPaymentPayloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      paymentRecoveryArtifactPath: TEST_PAYMENT_RECOVERY_REFERENCE.path,
      paymentRecoveryArtifactSha256: TEST_PAYMENT_RECOVERY_REFERENCE.sha256,
    });
    expect(persistedArtifact).toMatchObject({
      kind: "x402_signed_payment_recovery",
      paymentTransactionXdr: paymentAttempt().paymentTransactionXdr,
      signedPaymentPayloadJson: JSON.stringify(paymentAttempt().signedPaymentPayload),
    });
    expect(JSON.stringify(entries[0])).not.toContain("test-only");
    expect(JSON.stringify(entries[0])).not.toContain(paymentAttempt().paymentTransactionXdr);
  });

  it("records an unknown payment outcome after a submitted request loses its response", async () => {
    const entries: RunJournalEntry[] = [];
    let fetchCalls = 0;
    await expect(
      submitSignedPaymentRequest(ENDPOINT, scrapeInit(config(false)), RESULT_HASH, paymentAttempt(), {
        persistRecoveryArtifact: async () => TEST_PAYMENT_RECOVERY_REFERENCE,
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
      "payment_submission_prepared",
      "payment_outcome_unknown",
    ]);
  });

  it("bounds a hanging signed request and routes abort through the unknown-outcome journal", async () => {
    const entries: RunJournalEntry[] = [];
    await expect(
      submitSignedPaymentRequest(ENDPOINT, scrapeInit(config(false)), RESULT_HASH, paymentAttempt(), {
        requestTimeoutMs: 10,
        persistRecoveryArtifact: async () => TEST_PAYMENT_RECOVERY_REFERENCE,
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
      "payment_submission_prepared",
      "payment_outcome_unknown",
    ]);
    expect(entries[1]).toMatchObject({ event: "payment_outcome_unknown", stage: "signed_request" });
  });

  it("never submits payment if the durable pre-submit journal fails", async () => {
    let fetchCalls = 0;
    await expect(
      submitSignedPaymentRequest(ENDPOINT, scrapeInit(config(false)), RESULT_HASH, paymentAttempt(), {
        persistRecoveryArtifact: async () => TEST_PAYMENT_RECOVERY_REFERENCE,
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

  it("never journals or submits if the private payment recovery artifact is not durable", async () => {
    let journalCalls = 0;
    let fetchCalls = 0;
    await expect(
      submitSignedPaymentRequest(ENDPOINT, scrapeInit(config(false)), RESULT_HASH, paymentAttempt(), {
        persistRecoveryArtifact: async () => {
          throw new Error("recovery disk full");
        },
        appendJournal: async () => {
          journalCalls += 1;
          return "/tmp/payment.journal.jsonl";
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response("unexpected");
        },
      }),
    ).rejects.toThrow(/recovery artifact could not be durably created; refusing to submit/);
    expect(journalCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it("never submits payment if the exclusive funded-run lock cannot be advanced", async () => {
    let fetchCalls = 0;
    await expect(
      submitSignedPaymentRequest(ENDPOINT, scrapeInit(config(false)), RESULT_HASH, paymentAttempt(), {
        persistRecoveryArtifact: async () => TEST_PAYMENT_RECOVERY_REFERENCE,
        appendJournal: async () => "/tmp/payment.journal.jsonl",
        onSubmissionPrepared: async () => {
          throw new Error("lock storage unavailable");
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response("unexpected");
        },
      }),
    ).rejects.toThrow(/funded-run lock could not be durably advanced; refusing to submit/);
    expect(fetchCalls).toBe(0);
  });

  it("confirms feedback only after the exact signed hash reaches SUCCESS", async () => {
    const entries: RunJournalEntry[] = [];
    const result = await submitFeedbackTransaction(
      fakeFeedbackTransaction("SUCCESS"),
      paymentAttempt().startedAt,
      SCRAPPER_AGENT_ID,
      {
        verifyFinalized: async () => FAKE_FEEDBACK_PROOF,
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
    expect(entries[0]).toHaveProperty("signedTransactionXdrSha256");
    expect(JSON.stringify(entries[0])).not.toContain("signed-feedback-xdr-must-not-be-journaled");
  });

  it("treats either missing feedback response hash as unknown and never verifies or confirms", async () => {
    for (const missing of ["send", "final"] as const) {
      const entries: RunJournalEntry[] = [];
      let verificationCalls = 0;
      const transaction = fakeFeedbackTransaction("SUCCESS");
      transaction.send = async () => ({
        sendTransactionResponse: missing === "send" ? {} : { hash: TX },
        getTransactionResponse: missing === "final" ? { status: "SUCCESS" } : { status: "SUCCESS", txHash: TX },
      });
      await expect(
        submitFeedbackTransaction(transaction, paymentAttempt().startedAt, SCRAPPER_AGENT_ID, {
          verifyFinalized: async () => {
            verificationCalls += 1;
            return FAKE_FEEDBACK_PROOF;
          },
          appendJournal: async (_startedAt, entry) => {
            entries.push(entry);
            return "/tmp/feedback-integrity.journal.jsonl";
          },
        }),
      ).rejects.toThrow(/FEEDBACK_OUTCOME_UNKNOWN/);
      expect(verificationCalls).toBe(0);
      expect(entries.at(-1)).toMatchObject({
        event: "feedback_outcome_unknown",
        stage: "response_integrity",
      });
      expect(entries.some((entry) => entry.event === "feedback_confirmed")).toBe(false);
    }
  });

  it("journals terminal FAILED feedback without ever claiming confirmation", async () => {
    const entries: RunJournalEntry[] = [];
    await expect(
      submitFeedbackTransaction(fakeFeedbackTransaction("FAILED"), paymentAttempt().startedAt, SCRAPPER_AGENT_ID, {
        verifyFinalized: async () => FAKE_FEEDBACK_PROOF,
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
        verifyFinalized: async () => FAKE_FEEDBACK_PROOF,
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

  it("bounds a hanging feedback send/finality call and journals the signed hash as unknown", async () => {
    const entries: RunJournalEntry[] = [];
    const transaction = fakeFeedbackTransaction("SUCCESS");
    transaction.send = () => new Promise(() => undefined);
    await expect(
      submitFeedbackTransaction(transaction, paymentAttempt().startedAt, SCRAPPER_AGENT_ID, {
        sendTimeoutMs: 10,
        verifyFinalized: async () => FAKE_FEEDBACK_PROOF,
        appendJournal: async (_startedAt, entry) => {
          entries.push(entry);
          return "/tmp/feedback-timeout.journal.jsonl";
        },
      }),
    ).rejects.toThrow(/FEEDBACK_OUTCOME_UNKNOWN.*timed out/s);
    expect(entries.map((entry) => entry.event)).toEqual([
      "feedback_submitted",
      "feedback_outcome_unknown",
    ]);
  });

  it("treats a fresh-RPC feedback verification failure as unknown after SDK SUCCESS", async () => {
    const entries: RunJournalEntry[] = [];
    await expect(
      submitFeedbackTransaction(fakeFeedbackTransaction("SUCCESS"), paymentAttempt().startedAt, SCRAPPER_AGENT_ID, {
        verifyFinalized: async () => {
          throw new Error("independent envelope mismatch");
        },
        appendJournal: async (_startedAt, entry) => {
          entries.push(entry);
          return "/tmp/feedback-rpc.journal.jsonl";
        },
      }),
    ).rejects.toThrow(/FEEDBACK_OUTCOME_UNKNOWN.*independent envelope mismatch/s);
    expect(entries.at(-1)).toMatchObject({
      event: "feedback_outcome_unknown",
      stage: "independent_rpc_verification",
      feedbackTxHash: TX,
    });
  });
});

describe("x402 crash-safe filesystem state", () => {
  it("writes private durable JSONL and atomically replaces the final receipt on a real filesystem", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stellar-agent-search-x402-durability-"));
    try {
      const journal = join(directory, "run.journal.jsonl");
      await appendDurableJsonLine(journal, { sequence: 1 });
      await appendDurableJsonLine(journal, { sequence: 2 });
      expect((await stat(journal)).mode & 0o777).toBe(0o600);
      expect((await readFsFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        { sequence: 1 },
        { sequence: 2 },
      ]);

      const receipt = join(directory, "run.json");
      await writeAtomicJsonFile(receipt, { complete: true });
      expect((await stat(receipt)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFsFile(receipt, "utf8"))).toEqual({ complete: true });
      expect((await readdir(directory)).some((name) => name.includes(".tmp-"))).toBe(false);

      await expect(writeAtomicJsonFile(receipt, { invalid: 1n })).rejects.toThrow();
      expect(JSON.parse(await readFsFile(receipt, "utf8"))).toEqual({ complete: true });
      expect((await readdir(directory)).some((name) => name.includes(".tmp-"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent funded process for the same canonical request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stellar-agent-search-x402-lock-"));
    try {
      const identity = canonicalRequestIdentity(config(false), OTHER_ACCOUNT, SCRAPPER_AGENT_ID, ENDPOINT);
      const startedAt = "2026-07-29T00:00:00.000Z";
      const attempts = await Promise.allSettled([
        acquireFundedRunLock(identity, startedAt, directory),
        acquireFundedRunLock(identity, startedAt, directory),
      ]);
      expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(String((attempts.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)).toMatch(
        /REPLAY_BLOCKED/,
      );

      const lock = (attempts.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<
        Awaited<ReturnType<typeof acquireFundedRunLock>>
      >).value;
      expect((await stat(lock.path)).mode & 0o777).toBe(0o600);
      const journalPath = join(directory, `run-${startedAt.replace(/[:.]/g, "-")}.journal.jsonl`);
      const attempt = paymentAttempt();
      const signedPaymentPayloadJson = JSON.stringify(attempt.signedPaymentPayload);
      const recoveryArtifact = await writePaymentRecoveryArtifact(
        startedAt,
        {
          version: 1,
          kind: "x402_signed_payment_recovery",
          recordedAt: startedAt,
          ...identity,
          endpoint: ENDPOINT,
          challengeNetwork: attempt.challengeNetwork,
          asset: attempt.asset,
          payTo: attempt.payTo,
          price: attempt.price,
          paymentAuthorizationHash: RESULT_HASH,
          paymentTransactionXdr: attempt.paymentTransactionXdr,
          signedPaymentPayloadJson,
        },
        directory,
      );
      expect((await stat(recoveryArtifact.path)).mode & 0o777).toBe(0o600);
      const recoveryBytes = await readFsFile(recoveryArtifact.path);
      expect(createHash("sha256").update(recoveryBytes).digest("hex")).toBe(recoveryArtifact.sha256);
      expect(JSON.parse(recoveryBytes.toString("utf8"))).toMatchObject({
        paymentTransactionXdr: attempt.paymentTransactionXdr,
        signedPaymentPayloadJson,
      });
      expect((await readdir(directory)).some((name) => name.includes(".tmp-"))).toBe(false);
      await appendDurableJsonLine(journalPath, {
        event: "payment_submission_prepared",
        recordedAt: startedAt,
        payerPublicKey: identity.payerPublicKey,
        agentId: identity.agentId,
        endpoint: ENDPOINT,
        challengeNetwork: attempt.challengeNetwork,
        asset: attempt.asset,
        payTo: attempt.payTo,
        price: attempt.price,
        canonicalEndpoint: identity.canonicalEndpoint,
        requestMethod: identity.requestMethod,
        requestBodySha256: identity.requestBodySha256,
        requestDigest: identity.requestDigest,
        idempotencyKey: identity.idempotencyKey,
        paymentAuthorizationHash: RESULT_HASH,
        paymentTransactionXdrSha256: createHash("sha256").update(attempt.paymentTransactionXdr).digest("hex"),
        signedPaymentPayloadSha256: createHash("sha256").update(signedPaymentPayloadJson).digest("hex"),
        paymentRecoveryArtifactPath: recoveryArtifact.path,
        paymentRecoveryArtifactSha256: recoveryArtifact.sha256,
      } satisfies RunJournalEntry);
      await lock.markPaymentSubmissionPrepared({
        journalPath,
        authorizationHash: RESULT_HASH,
        paymentRecoveryArtifactPath: recoveryArtifact.path,
        paymentRecoveryArtifactSha256: recoveryArtifact.sha256,
      });
      expect(JSON.parse(await readFsFile(lock.path, "utf8"))).toMatchObject({
        state: "payment_submission_prepared",
        idempotencyKey: identity.idempotencyKey,
        journalPath,
        paymentAuthorizationHash: RESULT_HASH,
      });
      await expect(acquireFundedRunLock(identity, startedAt, directory)).rejects.toThrow(/REPLAY_BLOCKED/);
      await releaseReconciledFundedRunLock(identity.idempotencyKey, directory);
      await expect(stat(lock.path)).rejects.toMatchObject({ code: "ENOENT" });
      const journalEntries = (await readFsFile(journalPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(journalEntries.at(-1)).toMatchObject({
        event: "funded_lock_released",
        idempotencyKey: identity.idempotencyKey,
        previousState: "payment_submission_prepared",
      });
      await expect(acquireFundedRunLock(identity, startedAt, directory)).rejects.toThrow(/REPLAY_BLOCKED/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a prepared lock cannot be reconciled to its artifact and journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stellar-agent-search-x402-reconcile-"));
    try {
      const identity = canonicalRequestIdentity(config(false), OTHER_ACCOUNT, SCRAPPER_AGENT_ID, ENDPOINT);
      const lock = await acquireFundedRunLock(identity, paymentAttempt().startedAt, directory);
      await lock.markPaymentSubmissionPrepared({
        journalPath: join(directory, "run-2026-07-29T00-00-00-000Z.journal.jsonl"),
        authorizationHash: RESULT_HASH,
        paymentRecoveryArtifactPath: join(directory, "missing.payment-recovery.json"),
        paymentRecoveryArtifactSha256: TEST_PAYMENT_RECOVERY_REFERENCE.sha256,
      });
      await expect(
        releaseReconciledFundedRunLock(identity.idempotencyKey, directory),
      ).rejects.toThrow();
      expect((await stat(lock.path)).isFile()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

    const componentMessage = redactSensitiveError(
      new Error("provider provider-secret rejected token query-secret"),
      env,
    );
    expect(componentMessage).not.toContain("provider-secret");
    expect(componentMessage).not.toContain("query-secret");
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

  it("cancels a paid body that never finishes when its post-payment deadline expires", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await expect(readPaidResult(new Response(body), 10)).rejects.toThrow(/paid result body timed out/);
    expect(cancelled).toBe(true);
  });

  it("durably captures a signed-response transaction claim without journaling untrusted error text", async () => {
    const entries: RunJournalEntry[] = [];
    const untrustedReason = "PAYMENT-SIGNATURE=signed-capability-must-not-be-logged";
    const encoded = Buffer.from(
      JSON.stringify({
        success: false,
        payer: OTHER_ACCOUNT,
        transaction: TX,
        network: STELLAR_PUBNET_CAIP2,
        errorReason: untrustedReason,
      }),
    ).toString("base64");
    const response = new Response("", { status: 402, headers: { "PAYMENT-RESPONSE": encoded } });
    const claim = await captureUntrustedSettlementClaim(
      response,
      { payer: OTHER_ACCOUNT, network: STELLAR_PUBNET_CAIP2, amount: "1000" },
      paymentAttempt().startedAt,
      async (_startedAt, entry) => {
        entries.push(entry);
        return "/tmp/payment.journal.jsonl";
      },
    );
    expect(claim.paymentTxHash).toBe(TX);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: "settlement_claim_received",
      httpStatus: 402,
      decoded: true,
      claimSuccess: false,
      paymentTxHash: TX,
      claimedNetwork: STELLAR_PUBNET_CAIP2,
      claimedPayer: OTHER_ACCOUNT,
      claimedAmount: null,
    });
    expect(JSON.stringify(entries[0])).not.toContain(untrustedReason);
    expect(JSON.stringify(entries[0])).not.toContain(encoded);
    expect(() =>
      validateSettlementResponse(claim.response!, {
        payer: OTHER_ACCOUNT,
        network: STELLAR_PUBNET_CAIP2,
        amount: "1000",
      }),
    ).toThrow("x402 settlement reported failure");

    const storageFailure = await captureUntrustedSettlementClaim(
      response,
      { payer: OTHER_ACCOUNT, network: STELLAR_PUBNET_CAIP2, amount: "1000" },
      paymentAttempt().startedAt,
      async () => {
        throw new Error("disk full");
      },
    );
    expect(storageFailure.paymentTxHash).toBe(TX);
    expect(storageFailure.journalError).toContain("disk full");
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
    const txHash = transactionEnvelopeHash(envelope.toXDR(), Networks.PUBLIC);
    const authorizationHash = paymentAuthorizationHash(envelope.toXDR(), Networks.PUBLIC);
    const transfer = {
      toXDR: () => "AAAA",
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
      txHash,
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
    expect(assertOnchainSettlement(tx, txHash, expected)).toMatchObject({
      ledger: 123,
      confirmedAt: "2023-11-14T22:13:21.000Z",
    });
    expect(() => assertOnchainSettlement({ ...tx, status: "FAILED" }, txHash, expected)).toThrow(
      /not final-success/,
    );
    expect(() =>
      assertOnchainSettlement({ ...tx, createdAt: 1_699_999_999 }, txHash, expected),
    ).toThrow(/predates/);
    expect(() => assertOnchainSettlement(tx, txHash, { ...expected, amount: "1001" })).toThrow(
      /does not match expected/,
    );
    expect(() => assertOnchainSettlement({ ...tx, txHash: TX }, TX, expected)).toThrow(
      /envelope hash does not match/,
    );
  });

  it("rejects a prior identical transfer in the same RPC second unless its signed authorization matches", () => {
    const expectedEnvelope = paymentEnvelope(1n);
    const priorEnvelope = paymentEnvelope(2n);
    const transfer = {
      toXDR: () => "AAAA",
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
      txHash: transactionEnvelopeHash(priorEnvelope.toXDR(), Networks.PUBLIC),
      ledger: 122,
      createdAt: 1_700_000_000,
      envelopeXdr: priorEnvelope.toEnvelope(),
      events: { contractEventsXdr: [[transfer]] },
    };
    expect(() =>
      assertOnchainSettlement(priorSameSecond, priorSameSecond.txHash, {
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

  it("independently binds finalized give_feedback invocation and NewFeedback event to the full tuple", () => {
    const fixture = feedbackOnchainFixture();
    expect(
      assertOnchainFeedback(
        fixture.transaction,
        fixture.txHash,
        fixture.signedTransactionXdr,
        fixture.expected,
      ),
    ).toMatchObject({
      ledger: 456,
      feedbackIndex: "7",
      transactionXdr: fixture.signedTransactionXdr,
    });
    expect(() =>
      assertOnchainFeedback(
        fixture.transaction,
        fixture.txHash,
        fixture.signedTransactionXdr,
        { ...fixture.expected, tag2: "different" },
      ),
    ).toThrow(/does not match/);
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
    expect(isSuccessfulResult({ success: true, data: "URL: https://example.com\n\nContent:\n" })).toBe(false);
    expect(isSuccessfulResult({ success: true, data: "URL: https://example.com\n\nContent:\n \t\r\n" })).toBe(false);
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
    const identity = canonicalRequestIdentity(config(false), OTHER_ACCOUNT, SCRAPPER_AGENT_ID, ENDPOINT);
    const settlementEnvelope = paymentEnvelope(20n);
    const paymentTxHash = transactionEnvelopeHash(settlementEnvelope.toXDR(), Networks.PUBLIC);
    const startedAt = "2023-11-14T22:13:20.000Z";
    const settlementConfirmedAt = "2023-11-14T22:13:20.000Z";
    const feedbackUri = buildFeedbackEvidenceUri({
      agentId: SCRAPPER_AGENT_ID,
      owner: SCRAPPER_OWNER,
      endpoint: ENDPOINT,
      challengeNetwork: STELLAR_PUBNET_CAIP2,
      asset: USDC_PUBNET_ADDRESS,
      payTo: SCRAPPER_EXPECTED_PAY_TO,
      price: "1000",
      paymentTxHash,
      paymentAuthorizationHash: paymentAuthorizationHash(settlementEnvelope.toXDR(), Networks.PUBLIC),
      settlementLedger: 123,
      settlementConfirmedAt,
      resultHash: RESULT_HASH,
      resultOk: true,
      startedAt,
    });
    const feedback = feedbackOnchainFixture({
      caller: OTHER_ACCOUNT,
      agentId: SCRAPPER_AGENT_ID,
      value: 95n,
      valueDecimals: 0,
      tag1: "starred",
      tag2: "successRate",
      endpoint: ENDPOINT,
      feedbackUri,
      feedbackHash: createHash("sha256").update(feedbackUri).digest("hex"),
      submittedAtMs: Date.parse(startedAt),
    });
    const unrelatedFeedbackEventXdr = new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: StrKey.decodeContract(USDC_PUBNET_ADDRESS) as any,
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({ topics: [], data: nativeToScVal("feedback", { type: "symbol" }) }),
      ),
    }).toXDR("base64");
    const rec: RunRecord = {
      network: "mainnet",
      dryRun: false,
      payerPublicKey: OTHER_ACCOUNT,
      agentId: SCRAPPER_AGENT_ID,
      owner: SCRAPPER_OWNER,
      endpoint: ENDPOINT,
      canonicalEndpoint: identity.canonicalEndpoint,
      requestMethod: identity.requestMethod,
      requestBodySha256: identity.requestBodySha256,
      requestDigest: identity.requestDigest,
      idempotencyKey: identity.idempotencyKey,
      challengeNetwork: STELLAR_PUBNET_CAIP2,
      asset: USDC_PUBNET_ADDRESS,
      payTo: SCRAPPER_EXPECTED_PAY_TO,
      price: "1000",
      paymentTxHash,
      paymentAuthorizationHash: paymentAuthorizationHash(settlementEnvelope.toXDR(), Networks.PUBLIC),
      paymentTransactionXdrSha256: "12".repeat(32),
      signedPaymentPayloadSha256: "23".repeat(32),
      paymentResponseHeaderBytes: 128,
      paymentResponseHeaderSha256: "34".repeat(32),
      settlementRecomputedTxHash: paymentTxHash,
      settlementTransactionXdr: settlementEnvelope.toXDR(),
      settlementLedger: 123,
      settlementConfirmedAt,
      resultHash: RESULT_HASH,
      resultOk: true,
      feedbackTxHash: feedback.txHash,
      feedbackIndex: "7",
      feedbackLedger: feedback.transaction.ledger,
      feedbackConfirmedAt: "2023-11-14T22:13:21.000Z",
      feedbackTransactionXdr: feedback.signedTransactionXdr,
      feedbackEventXdr: feedback.transaction.events.contractEventsXdr[0][0].toXDR("base64"),
      startedAt,
      finishedAt: "2023-11-14T22:13:22.000Z",
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
    expect(() => assertCompleteEvidenceRecord({ ...rec, feedbackTxHash: paymentTxHash })).toThrow(
      /two distinct transactions/,
    );
    expect(() => assertCompleteEvidenceRecord({ ...rec, settlementRecomputedTxHash: TX })).toThrow(
      /settlement XDR\/hash binding/,
    );
    expect(() =>
      assertCompleteEvidenceRecord({ ...rec, feedbackEventXdr: unrelatedFeedbackEventXdr }),
    ).toThrow(/feedback envelope\/event\/source binding/);
    expect(() => assertCompleteEvidenceRecord({ ...rec, resultHash: "ef".repeat(32) })).toThrow(
      /feedback envelope\/event\/source binding/,
    );
  });
});
