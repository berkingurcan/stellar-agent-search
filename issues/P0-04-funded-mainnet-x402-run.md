# P0-04 — Funded mainnet x402 run → two transaction hashes

**Owner:** Builder · **Status:** resolved 30 July 2026 — funded mainnet payment, paid result and on-chain feedback completed

## Outcome

The agent-finds-agent loop completed on Stellar mainnet at 2026-07-30T08:05Z:

- x402 USDC payment: [`de0717ec…be3c55`](https://stellar.expert/explorer/public/tx/de0717ecb5b34b712fd196c8438cb20bff52e4f843fc7b8263e03b1dd5be3c55), successful in ledger `63715338`.
- Reputation feedback: [`10d73971…740846`](https://stellar.expert/explorer/public/tx/10d739713a02ae517bc96b8507d0d6ae28913ccdd7b10484f77e37bf8c740846), successful in ledger `63715340`.
- The paid result passed the script's response validation before feedback was submitted.

Both transaction states were independently rechecked through Stellar Horizon on 28 September 2026. The
transaction hashes are the durable completion evidence. The captured demo still needs an uploaded link.

## What the run proved

1. The MCP discovered the source-pinned Scrapper agent and retrieved its self-declared x402 service candidate.
2. The separate keyed demo validated the agent, owner, endpoint, payee, network, asset, price and request identity.
3. The client submitted one signed payment, validated the paid result and independently checked settlement.
4. The client wrote feedback to the Stellar 8004 Reputation Registry and recorded the resulting hash.
5. Replay protection and durable recovery records prevented an uncertain submission from becoming an automatic second payment.

The MCP itself remained read-only and keyless throughout the run.

## Residual follow-up

The target's unsigned challenge echoed an `http://` resource URL while the actual request remained pinned to
HTTPS. The evidence client accepted only that reviewed scheme difference and still required every signed
payment field to match. The upstream HTTPS metadata correction remains tracked in
[08](P2-08-verify-scrapper-endpoint-is-live.md), but it no longer blocks this completed evidence run.

## Acceptance — complete

The two mainnet transaction hashes are recorded in `docs/evidence.md` §2. Private recovery artifacts and run
journals are intentionally excluded from the public repository.
