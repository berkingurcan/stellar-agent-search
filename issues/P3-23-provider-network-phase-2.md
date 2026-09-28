# P3-23 — Stellar Agent Search Phase 2: Provider Network

**Owner:** Code + Builder · **Status:** proposed follow-on Instaward scope; not implemented

## Continuation

Phase 1 shipped the read-only, keyless discovery layer and proved one tightly reviewed mainnet flow that finds,
pays and reviews a specific x402 service. That proof is intentionally pinned to one agent, endpoint, payee,
request and response contract. It is evidence that the chain works, not a reusable provider platform.

Phase 2 would generalize that proof while keeping the existing search MCP read-only and keyless.

## Proposed scope

1. **Provider Kit** — a reusable Stellar x402 service template with pricing, payment verification, request
   identity, receipts and documented service metadata.
2. **Job and result recovery** — a provider-independent contract for job creation, status and authenticated
   result lookup after a timeout or client restart, without automatic payment replay.
3. **Client runner** — a separate keyed client layer for wallet custody, budgets, payment approval and result
   retrieval. Private keys must never enter the search MCP.
4. **Independent provider pilot** — onboard two independently operated services and record integration issues,
   successful paid calls and recovery evidence.
5. **Public evidence** — provider documentation, tests, a working demo and a concise pilot report.

## Existing foundation reused

- 13 read-only MCP discovery/evaluation tools, resources and prompts.
- Exact-version client setup for Claude Code, Cursor and Codex.
- Stellar x402 challenge validation, one-shot submission and independent settlement checks.
- Durable payment journal/replay protection from the reference demo.
- Stellar 8004 identity and feedback integration.

## Explicit boundaries

- Do not add signing, wallets or provider execution to the existing read-only MCP process.
- Do not claim self-declared endpoints are verified. Pilot evidence must state exactly what was tested and when.
- Do not mix mainnet registry data with testnet payments. Every demonstration must name one coherent network.
- Do not create a second registry, indexer or canonical database.
- Do not count the Algoria hackathon prototype as Phase 2 delivery; it is prior UX/payment validation.

## Acceptance target

- Two independent providers use the same published kit without provider-specific client code.
- A user completes paid service calls through the separate client runner.
- At least one interrupted job is recovered through the standard job contract without a second payment.
- Evidence includes source, integration docs, test output, transaction/receipt records and a public demo.
