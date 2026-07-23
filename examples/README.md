# x402 on-chain loop — the agent-finds-agent reference demo

`x402-demo.ts` is the SOW **Deliverable 2** reference script: **one autonomous agent discovers, pays, and
rates another, with no human in the loop**, on Stellar **mainnet**.

```
discover (MCP)  →  pay (x402/USDC)  →  receive result  →  rate (on-chain reputation)
```

It composes the three pillars of the project:

- **MCP (discovery)** — spawns *our own* read-only, keyless MCP server over stdio and calls `find_agent` +
  `get_agent_profile` to resolve the scrapper agent's x402 endpoint and capabilities.
- **x402 (payment)** — the manual HTTP-402 flow (`@x402/fetch` + `@x402/stellar`, OpenZeppelin mainnet
  facilitator) settles real USDC. `payTo` comes from the 402 challenge.
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

## Prerequisites

- Node ≥ 18.
- The MCP server built: from the repo root run `npm run build` (produces `../dist/index.js`).
- Demo deps installed at the repo root (`@x402/core`, `@x402/fetch`, `@x402/stellar`, `@stellar/stellar-sdk`,
  `@trionlabs/stellar8004`, `dotenv`, `@modelcontextprotocol/sdk`).
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
# edit examples/.env — set STELLAR_PRIVATE_KEY, X402_API_KEY, STELLAR_NETWORK
```

Key vars (full list in `.env.example`): `STELLAR_PRIVATE_KEY`, `X402_API_KEY`, `STELLAR_NETWORK`
(`mainnet` default), `MCP_SERVER_ENTRY` (`../dist/index.js`), `MIN_USDC`, `MIN_XLM`, `DRY_RUN`,
`SCRAPE_TARGET` / `SCRAPE_BODY` (the JSON task sent to the scrapper endpoint).

## Run

Always dry-run first (preflight + discovery only, no spend; preflight failures are advisory here):

```bash
# Testnet dry-run (recommended gate before any mainnet run)
STELLAR_NETWORK=testnet DRY_RUN=1 npx tsx examples/x402-demo.ts

# Mainnet dry-run
DRY_RUN=1 npx tsx examples/x402-demo.ts

# Full mainnet run (real USDC + on-chain reputation write)
npx tsx examples/x402-demo.ts | tee examples/run-$(date +%Y%m%d).log
```

(`tsx` runs the TypeScript directly; alternatively compile with the root build and run the emitted JS.)

## Output & evidence

On a full run the script prints **two mainnet tx hashes** with Stellar Expert links and writes
`examples/run-<timestamp>.json` (**no secrets** — network, payer G-address, agentId, endpoint, payTo, price,
both tx hashes, timestamps, Expert links). Dry-run writes the same record with empty tx fields.

- Payment tx: `https://stellar.expert/explorer/public/tx/<hash>` — USDC transfer to the scrapper's payTo.
- Feedback tx: `https://stellar.expert/explorer/public/tx/<hash>` — emits `NewFeedback` for the agent.
- Reputation contract: `.../contract/CBOIAIMMWAXI57OATLX6BWVDQLCC4YU55HV6MZXFRP6CBSGAMXSTEPPA`
- USDC contract: `.../contract/CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`

## Flow (what the script does)

| Step | Where | What |
|---|---|---|
| 1 | `runPreflight` | Horizon balances (USDC trustline? USDC ≥ `MIN_USDC`? XLM ≥ `MIN_XLM`?), RPC health, facilitator key, payer ≠ scrapper owner. Aborts before spend (advisory in dry-run). |
| 2 | `discoverScrapper` | Spawns the read-only MCP server (secret-free env), `find_agent` → pick scrapper → `get_agent_profile` → resolve endpoint + x402 flag. |
| 3/4 | `payForService` | `fetch` → 402 → `createPaymentPayload` → retry with signature; `payTo` from the challenge; ≤1 fresh-payload retry (auth expiry); reads settlement tx hash from `PAYMENT-RESPONSE`. |
| 5 | `writeFeedback` | `createClients(...).reputation.give_feedback({...})` via `wrapBasicSigner` — the only key/signing site besides the payment. |
| 6 | `recordEvidence` | Prints 2 tx hashes + Expert links; writes `run.json` (no secrets). |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `USDC trustline missing` | Add the trustline before running — USDC otherwise fails silently. |
| `expected 402, got <n>` | Scrapper endpoint down or not x402-gated; check `MCP_SERVER_ENTRY` resolved the right agent. |
| `network mismatch` | The 402 challenge network ≠ your `STELLAR_NETWORK`. |
| `payment rejected by facilitator` | Auth entry expired (retried once), amount/asset mismatch, or facilitator key missing server-side. |
| `SelfFeedback` revert | Payer key == scrapper owner/wallet — use a different key. |
| `give_feedback` fails after payment | XLM too low for the self-paid fee — raise the balance (`MIN_XLM`). |
