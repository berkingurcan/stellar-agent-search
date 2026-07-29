# x402 on-chain loop — the agent-finds-agent reference demo

`x402-demo.ts` is the SOW **Deliverable 2** reference script: **one autonomous agent discovers, pays, and
rates another, with no human in the loop**, on Stellar **mainnet**.

```
discover (MCP)  →  pay (x402/USDC)  →  receive result  →  rate (on-chain reputation)
```

It composes the three pillars of the project:

- **MCP (discovery)** — spawns *our own* read-only, keyless MCP server over stdio and calls `find_agent` +
  `get_agent_profile` to resolve the scrapper agent's x402 endpoint and capabilities.
- **x402 (payment)** — the manual HTTP-402 flow (`@x402/fetch` + `@x402/stellar`) settles real USDC.
  The challenge's `payTo` is accepted only when it matches the reviewed, source-pinned Scrapper payee.
- **stellar-8004 (reputation)** — `@trionlabs/stellar8004` `give_feedback` writes on-chain reputation, so the
  *next* agent's discovery query sees an updated, verifiable score.

## Security boundary (non-negotiable)

> The MCP server is **READ-ONLY and holds NO private keys.** Every signing operation — the x402 USDC payment
> **and** the `give_feedback` reputation write — happens **only** in `x402-demo.ts`, using
> `STELLAR_PRIVATE_KEY` from the environment. The MCP subprocess is spawned with an **env allowlist**
> (`STELLAR_NETWORK`, `PATH`, optional non-secret RPC/explorer overrides) that **never** contains
> `STELLAR_PRIVATE_KEY` or `X402_API_KEY`. The key is never logged, never written to `run.json`, never sent
> over MCP. This demo is the only trusted, keyed actor.

Reviewer check: the child `env` is built explicitly in `discoverScrapper()` — not spread from `process.env` —
and asserts the secret keys are absent before spawning.

## Evidence target and fail-closed policy

This is a reference proof for one known mainnet deployment, not a general “pay whatever discovery returned”
script. The signing path pins all of these facts in source:

- agent id: `10`
- owner: `GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V`
- allowed endpoint: `https://scrapper.stellar8004.com/task`
- expected x402 `payTo`: `GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V`

If the deployment changes, update and review these constants before running again. Do not turn them into
unreviewed runtime discovery fallbacks. Both dry-run and real mode fail when an MCP tool returns `isError`,
omits structured output, does not return agent 10, reports `x402=false`, changes the owner, or changes the
endpoint. A dry-run with failed discovery is therefore never printed or recorded as successful.

## Prerequisites

- Node ≥ 20.
- The MCP server built: from the repo root run `npm run build` (produces `../dist/index.js`).
- Demo deps installed at the repo root (`@x402/core`, `@x402/fetch`, `@x402/stellar`, `@stellar/stellar-sdk`,
  `@trionlabs/stellar8004`, `dotenv`, `@modelcontextprotocol/client`).
- For a **real** run: an S-format payer account, funded and trustlined (see below).

## Fund & trustline the payer (real run only)

The x402 payment fee is fee-bumped by the facilitator, but the payer still needs XLM:

1. **Reserves + trustline:** a funded classic account (~1 XLM base reserve) **+ 0.5 XLM per trustline**.
2. **`give_feedback` is self-paid** — a normal Soroban tx, **not** fee-bumped. The payer pays its own fee.

Practical target: **~3–5 XLM + a small USDC balance** (e.g. 0.5–1 USDC; the scrapper price is ~\$0.01).

One-time setup:

1. Create/choose an S-format keypair (the payer); record the G public key.
2. Fund it with a few XLM on the target network.
3. **Add the USDC trustline** (Stellar Lab / Freighter / a `changeTrust` op). **REQUIRED — without it, USDC
   transfers fail *silently*.** (The mainnet USDC classic issuer G-address is Circle's; pin it from Circle /
   Stellar docs — this demo detects the trustline via Horizon balances and does not hardcode the issuer.)
4. Acquire a small USDC amount on the trustline.
5. Run `DRY_RUN=1` first to verify preflight before spending.

## Configure

```bash
cp examples/.env.example examples/.env
# edit examples/.env — set STELLAR_PRIVATE_KEY, STELLAR_NETWORK
```

Key vars (full list in `.env.example`): `STELLAR_PRIVATE_KEY`, `STELLAR_NETWORK` (`mainnet` default),
`MCP_SERVER_ENTRY` (`../dist/index.js`), `MIN_USDC`, `MIN_XLM`, `MAX_PRICE_USDC`, `DRY_RUN`,
`SCRAPE_TARGET` / `SCRAPE_BODY` (the JSON task sent to the scrapper endpoint).

> **No facilitator credential is needed.** This client signs the payment locally and submits it as a header;
> the *resource server* verifies and settles it with whichever facilitator it chose — the live scrapper
> challenge names none. `X402_API_KEY` stays in the secret allowlist so a stray value can never reach the MCP
> subprocess, but nothing in the script reads it. An earlier revision made it a **fatal** mainnet preflight
> check, which would have aborted a funded run over a credential that is never used.

> **What the challenge may ask for is not trusted.** The resource server writes the 402 challenge, so the
> demo requires exactly one `exact` requirement and checks every server-controlled field before a signature
> exists: network must be `stellar:pubnet`, asset must be the mainnet USDC SAC `@x402/stellar` publishes,
> `payTo` must equal the source-pinned expected payee (and not the payer), amount must be a positive base-unit
> integer, and price must be at or below `MAX_PRICE_USDC` (default `0.10`). A funded evidence run is mainnet-only.

## Run

Always dry-run first (preflight + discovery only, no spend). Balance/key/RPC preflight failures are advisory
in dry-run, but MCP discovery, x402 capability, pinned identity, and endpoint failures are fatal:

```bash
# Mainnet dry-run — the gate before any funded run. Spends nothing.
DRY_RUN=1 npx tsx examples/x402-demo.ts

# Full mainnet run (real USDC + on-chain reputation write)
npx tsx examples/x402-demo.ts | tee examples/run-$(date +%Y%m%d).log
```

(`tsx` runs the TypeScript directly; alternatively compile with the root build and run the emitted JS.)

## Output & evidence

On a full run the script prints **two mainnet tx hashes** with Stellar Expert links and writes
`examples/run-<timestamp>.json` (**no secrets** — network, payer G-address, pinned identity/endpoint,
challenge network/asset/payTo/price, payment tx hash, exact response-body SHA-256, feedback tx hash,
timestamps, Expert links). Dry-run writes the same record with empty payment/result/feedback fields.

The full receipt is written only when the initial response was exactly HTTP 402, the settlement header reports
success with the expected payer/network/amount, Stellar RPC independently confirms a fresh final transaction
with the exact USDC asset/payer/payee/amount transfer, the paid body was non-empty and usable, its SHA-256 was recorded,
and `give_feedback` returned a valid 32-byte transaction hash. An invalid paid result may still receive a
below-expectation feedback entry, but it is not labeled or written as successful acceptance evidence.

- Payment tx: `https://stellar.expert/explorer/public/tx/<hash>` — USDC transfer to the scrapper's payTo.
- Feedback tx: `https://stellar.expert/explorer/public/tx/<hash>` — emits `NewFeedback` for the agent.
- Reputation contract: `.../contract/CBOIAIMMWAXI57OATLX6BWVDQLCC4YU55HV6MZXFRP6CBSGAMXSTEPPA`
- USDC contract: `.../contract/CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`

## Flow (what the script does)

| Step | Where | What |
|---|---|---|
| 1 | `runPreflight` | Horizon balances (USDC trustline? USDC ≥ `MIN_USDC`? XLM ≥ `MIN_XLM`?), RPC health, payer ≠ scrapper owner. Aborts before spend (balance/key/RPC checks advisory in dry-run). |
| 2 | `discoverScrapper` | Spawns the read-only MCP server (secret-free env), requires successful structured results, finds agent 10, fetches its profile, then validates x402 + pinned owner + endpoint without fallback. |
| 3/4 | `payForService` | `fetch` → require 402 → validate exact/pubnet/USDC/amount/timeout/sponsorship/pinned payTo → sign once → validate settlement response → independently verify the exact final transfer via RPC → hash exact result bytes. Never auto-retries a submitted payment. |
| 5 | `writeFeedback` | `createClients(...).reputation.give_feedback({...})` via `wrapBasicSigner` — the only key/signing site besides the payment. |
| 6 | `recordEvidence` | Revalidates the complete receipt, prints 2 tx hashes + result SHA-256 + Expert links, then writes `run.json` (no secrets). |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `USDC trustline missing` | Add the trustline before running — USDC otherwise fails silently. |
| `expected 402, got <n>` | Scrapper is not currently x402-gated or the deployment changed. HTTP 200 is not accepted as paid evidence. |
| `network mismatch` | The 402 challenge network ≠ your `STELLAR_NETWORK`. |
| `owner/endpoint/payTo mismatch` | Registry or deployment facts changed. Verify independently, then make a reviewed source change; do not bypass the pin at runtime. |
| `settlement transaction ...` | The response receipt or independent RPC finality/transfer check failed. Inspect the ledger before any rerun; the script will not auto-pay twice. |
| `payment rejected by facilitator` | Inspect whether settlement happened before rerunning. The client deliberately does not auto-retry a submitted payment. |
| `SelfFeedback` revert | Payer key == scrapper owner/wallet — use a different key. |
| `give_feedback` fails after payment | XLM too low for the self-paid fee — raise the balance (`MIN_XLM`). |
