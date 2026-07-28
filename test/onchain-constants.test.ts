/**
 * onchain-constants.test.ts — bind the chain constants we hardcode to the
 * authority that already publishes them.
 *
 * `src/lib/agentcard.ts` hardcodes the USDC SEP-41/SAC contract address and the
 * CAIP-2 chain id per network, because the read-only server must not import a
 * signing-capable package just to read two constants. The values are correct,
 * but "correct once, by hand" is how the SKILL.md tool count went stale.
 *
 * The blast radius here is worse than a stale doc: these two values are emitted
 * in the AgentCard's a2a-x402 `accepts` block, which is what an A2A/AP2 client
 * reads to decide *which asset on which chain* to pay. A wrong asset address
 * sends a real payment to the wrong contract.
 *
 * `@x402/stellar` is already a dependency (used by `examples/x402-demo.ts`) and
 * exports these as `USDC_PUBNET_ADDRESS` / `USDC_TESTNET_ADDRESS` /
 * `STELLAR_PUBNET_CAIP2` / `STELLAR_TESTNET_CAIP2`. Tests are not shipped, so
 * importing it here costs the published server nothing and keeps `src/` keyless.
 */

import { describe, it, expect } from "vitest";
import {
  USDC_PUBNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
} from "@x402/stellar";
import { toAgentCard } from "../src/lib/agentcard.js";
import type { AgentProfile } from "../src/types.js";

const G_ADDR = "GAAIBWG3M3U6PAS3IC5BATPT52XKNYXBRJXQIPHEDQUQIEFQDYH4KZY7";

/** Minimal x402-capable profile on the given network. */
function profileOn(network: string): AgentProfile {
  return {
    id: 1,
    stellarId: `stellar:${network}:C#1`,
    caip2Id: "stellar:pubnet:C#1",
    network,
    owner: G_ADDR,
    wallet: G_ADDR,
    agentUri: "https://agent.example.com/.well-known/agent.json",
    capabilities: { x402: true, mpp: false, hasServices: true, supportedTrust: [] },
    supportedTrust: [],
    scores: { average: null, total: null, feedbackCount: 0, uniqueClients: 0 },
    verification: {
      status: "skipped",
      declared: { average: null, feedbackCount: 0, uniqueClients: 0 },
      checkedAt: "2026-01-01T00:00:00.000Z",
    },
    verified: false,
    flags: {
      unrated: true,
      newAgent: false,
      lowConfidence: true,
      verified: false,
      verificationMismatch: false,
    },
    createdAt: null,
    txHash: null,
    resolveStatus: null,
    selfDeclared: {
      name: "X",
      description: null,
      image: null,
      services: [{ name: "svc", endpoint: "https://svc.example.com/task" }],
      metadata: {},
    },
  } as AgentProfile;
}

/** The a2a-x402 `accepts[0]` entry the card advertises. */
function acceptsEntry(network: string) {
  const card = toAgentCard(profileOn(network));
  const ext = card.capabilities.extensions?.find((e) =>
    e.uri.includes("a2a-x402"),
  );
  expect(ext, "card should carry the a2a-x402 extension").toBeTruthy();
  return (ext!.params as { accepts: Array<Record<string, unknown>> }).accepts[0];
}

describe("AgentCard advertises the chain constants @x402/stellar publishes", () => {
  it("mainnet: USDC asset and CAIP-2 network match the x402 SDK", () => {
    const accept = acceptsEntry("mainnet");
    expect(accept.asset).toBe(USDC_PUBNET_ADDRESS);
    expect(accept.network).toBe(STELLAR_PUBNET_CAIP2);
  });

  it("testnet: USDC asset and CAIP-2 network match the x402 SDK", () => {
    const accept = acceptsEntry("testnet");
    expect(accept.asset).toBe(USDC_TESTNET_ADDRESS);
    expect(accept.network).toBe(STELLAR_TESTNET_CAIP2);
  });

  it("the two networks do not share an asset address", () => {
    // Guards the copy-paste failure mode: mainnet USDC advertised on testnet
    // (or worse, the reverse) is a payment sent to a contract that is not USDC.
    expect(USDC_PUBNET_ADDRESS).not.toBe(USDC_TESTNET_ADDRESS);
    expect(acceptsEntry("mainnet").asset).not.toBe(acceptsEntry("testnet").asset);
  });
});
