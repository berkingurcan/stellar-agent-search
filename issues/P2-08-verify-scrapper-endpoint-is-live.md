# P2-08 — Verify the target agent's endpoint is live before spending

**Owner:** Upstream Scrapper deploy owner · **Blocks:** [04](P0-04-funded-mainnet-x402-run.md) · **Status:**
**BLOCKED 2026-07-29 — live challenge advertises HTTP; no funded run until fixed and re-verified**

## Problem

The funded run and Recording 2 both depend on one agent — id 10, "Scrapper",
`https://scrapper.stellar8004.com/task` — actually answering with a 402 challenge and then doing the work.

Nobody had checked that it is up, and there is almost no fallback: the live registry reported
**`agentsWithX402: 3`** out of 66 agents.

## Verified 2026-07-29

**Catalog** — `stellar-agent-search services --x402` now returns **2** x402 agents, not 3. Under
`stellar-agent-search-declared-evidence-v1`, agent 10 is still first (score 50); the only other is agent 13
(`tantk-rendergate-mainnet.hf.space/render`, score 0). These are indexer-declared heuristic scores, not
endpoint or payment verification. The fallback is thinner than this issue assumed — one unrated candidate.

**Endpoint** — an unpaid POST to `https://scrapper.stellar8004.com/task` answers **HTTP 402** with a live x402
v2 challenge. The body is `{}`; the challenge is in the base64 `payment-required` **header**:

```json
{ "x402Version": 2,
  "resource": { "url": "http://scrapper.stellar8004.com/task",
                "description": "Scrapes URLs and returns structured data … $0.0001 USDC per scrape via x402 on Stellar." },
  "accepts": [{ "scheme": "exact", "network": "stellar:pubnet", "amount": "1000",
                "asset": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
                "payTo": "GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V",
                "maxTimeoutSeconds": 300, "extra": { "areFeesSponsored": true } }] }
```

Cross-checks against the challenge:

- `network` is `stellar:pubnet` — matches the configured CAIP-2 id, so the demo's mismatch abort will not fire.
- `asset` is the USDC SAC `@x402/stellar` publishes as `USDC_PUBNET_ADDRESS`.
- `amount` `1000` at 7 decimals = **0.0001 USDC**, not the ~\$0.01 the docs claimed. Corrected in
  `docs/recordings.md`.
- `payTo` is `GDDT…HV2V`, the Scrapper's **owner** — so this is the address the payer keypair must not be
  ([04](P0-04-funded-mainnet-x402-run.md)'s `SelfFeedback` prerequisite).
- `extra.areFeesSponsored: true` — the resource server sponsors the payment fee.

**Dry run** — `DRY_RUN=1 npx tsx examples/x402-demo.ts` reaches discovery cleanly and resolves
`agentId=10 x402=true endpoint=https://scrapper.stellar8004.com/task`, RPC healthy.

## What this run surfaced

The dry run was supposed to answer [04](P0-04-funded-mainnet-x402-run.md)'s facilitator question. It answered
it and found a defect on the way — see that issue: the challenge names **no facilitator**, this client never
contacts one, and the fatal `X402_API_KEY` preflight would have aborted the funded run for nothing.

## Funded-run gate — confirmed again 2026-07-29 23:04 UTC

An unpaid HTTPS `POST https://scrapper.stellar8004.com/task` still returns a v2 challenge whose
`resource.url` is **`http://scrapper.stellar8004.com/task`**. The local evidence client intentionally pins the
public HTTPS resource and rejects this exact live response with:

```text
resource mismatch: challenge=http://scrapper.stellar8004.com/task expected=https://scrapper.stellar8004.com/task
```

This is not a reason to relax the client pin or silently canonicalize schemes. The upstream Express/x402
deployment must emit its reviewed public HTTPS URL (for example by configuring the trusted proxy/public base URL
correctly). After that change, capture the unpaid 402 again and add the real header as a regression fixture.
**Do not fund or tag the run complete before the live challenge and the HTTPS pin agree.**

## Acceptance

- [x] A dry run that reaches the pinned discovery endpoint.
- [x] Live 402 tuple captured again on 2026-07-29; HTTP resource mismatch reproduced locally.
- [ ] Upstream challenge emits `https://scrapper.stellar8004.com/task`.
- [ ] Repeat the unpaid 402 check on the funded-run day; only then remove this gate.
