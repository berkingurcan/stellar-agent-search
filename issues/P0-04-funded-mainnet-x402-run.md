# P0-04 — Funded mainnet x402 run → two transaction hashes

**Owner:** Builder (spends real USDC) · **Blocks:** Deliverable 2, recording 2 · **Status:** ready to execute —
payer funded 30 July 2026 (XLM + USDC trustline + 1 USDC), preflight green. [08](P2-08-verify-scrapper-endpoint-is-live.md)'s
`http://` echo is now tolerated by a reviewed client-side policy: the unsigned challenge `resource.url` may match the
pinned URL in either scheme, while the fetch target stays HTTPS-pinned and every payment field remains an exact
match. The upstream HTTPS fix is still requested; only the recorded run remains here.

## Problem

The agent-finds-agent loop — discover, pay over x402, receive the work, write reputation feedback back
on-chain — is **code-complete but never executed with funds**. It is the headline deliverable and the only one
with no evidence behind it.

What *is* verified: the dry run reaches discovery cleanly, the target endpoint answers a real 402 challenge
([08](P2-08-verify-scrapper-endpoint-is-live.md)), and the implementation matches the official
[Stellar x402 quickstart](https://developers.stellar.org/docs/build/agentic-payments/x402/quickstart-guide)
call for call — `x402Client` / `x402HTTPClient`, `createEd25519Signer`, `ExactStellarScheme`,
`getPaymentRequiredResponse` → `createPaymentPayload` → `encodePaymentSignatureHeader`, and the trustline
preflight the docs call out as the most common failure.

## Blocking prerequisite — RESOLVED 2026-07-29

The question was which of the two documented facilitators the target answers with, because the mainnet
preflight *required* `X402_API_KEY`, which assumed OpenZeppelin's.

**Neither.** The live challenge from `scrapper.stellar8004.com` names **no facilitator at all**, and it does
not need to: in this flow the client signs the payment locally and submits it as a header, and the *resource
server* verifies and settles it with whichever facilitator it chose. Reading the script confirms it —
`X402_API_KEY` appeared only in the preflight and in the secret-exclusion assertion, and **never in a
request**. `settleOnce()` calls `fetch(url, …)` with nothing but the payment signature headers.

So the check was a **fatal gate on a credential nothing reads**, and on a real run it aborts before money
moves — the exact wrong-reason failure this section was written to prevent. It has been removed, with the
reasoning left in place at the call site so it does not come back. `examples/.env.example`,
`examples/README.md` and `docs/recordings.md` no longer ask for the key.

While confirming this, the challenge-validation gap next to it was closed too: the resource server *writes*
the challenge, so every field it dictates is now checked before a signature exists — network (already there),
**asset** must be the USDC SAC `@x402/stellar` publishes, **`payTo`** must not be the payer itself, and
**price** must be at or below `MAX_PRICE_USDC` (default `0.10`). Previously a challenge naming any asset and
any amount would have been signed as-is.

## Remaining prerequisites

- **Hard gate:** [08](P2-08-verify-scrapper-endpoint-is-live.md) must confirm that the live 402 challenge's
  `resource.url` is the pinned HTTPS endpoint. On 2026-07-29 23:04 UTC it still advertised HTTP, so the client
  correctly aborted before signing. Fix the upstream public/proxy URL; do not weaken the local pin.

- Payer keypair **separate from the target agent's owner** — paying yourself reverts with `SelfFeedback`. The
  address to avoid is the challenge's `payTo`, `GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V`.
- **USDC trustline added.** Without it USDC transfers fail silently.
- ~3–5 XLM (reserves + the self-paid `give_feedback` fee) and 0.5–1 USDC. The scrapper's live price is
  **0.0001 USDC** per scrape, so the USDC side is a rounding error; the XLM is the real requirement.
- [08](P2-08-verify-scrapper-endpoint-is-live.md) — re-confirm the endpoint is up **on the day**.

## Acceptance

Two mainnet transaction hashes (the USDC payment and the `give_feedback` write), both resolving on
stellar.expert, pasted into `docs/evidence.md` §2, plus the fsynced append-only
`examples/run-<timestamp>.journal.jsonl` recovery trail and final `examples/run-<timestamp>.json` receipt.
