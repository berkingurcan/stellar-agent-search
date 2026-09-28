# P3-23 — Stellar Agent Search Phase 2: Provider Network

**Owner:** Code + Builder · **Status:** proposed follow-on Instaward scope; not implemented

## Why this is the next phase

Stellar Agent Search already helps AI assistants find and evaluate agents on Stellar. A mainnet reference demo
also proved that a client can find one service, pay it, receive a result and write feedback.

Algoria later tested the buyer experience during a hackathon: users could request and pay for services from
Claude or Codex. It was a useful prototype, but it did not give independent providers a shared way to connect.

Phase 2 fills that gap. It is a continuation of Stellar Agent Search, not a separate product.

## What Phase 2 will add

1. **Provider Kit:** starter code and documentation for listing a service, setting a price, accepting Stellar
   USDC and returning a result.
2. **Payment Client:** a separate client for wallets, spending limits and payment approval. Private keys stay
   outside the read-only search server.
3. **Job Recovery:** users can check a paid job after a timeout or restart and receive the result without paying
   again.
4. **Independent Pilot:** two outside developers connect real services with the same kit.
5. **Public Evidence:** five user tests, a working demo, documentation, test results and payment records.

## Example

A user asks an AI assistant to make a phone call or create a TikTok video. Stellar Agent Search finds a service,
the user approves the price, the provider receives USDC and returns the work. If the job is delayed, the user
can recover it without a second payment.

## What Phase 1 already provides

- 13 read-only tools for discovery, ranking and reputation.
- Setup for Claude Code, Cursor and Codex.
- A successful mainnet payment, result and feedback flow.
- Payment checks and replay protection in the reference demo.

## Boundaries

- The search server remains read-only and never holds private keys.
- A listed endpoint is not called verified unless the pilot actually tests it.
- Each demo uses one clear Stellar network from start to finish.
- Algoria is prior hackathon learning, not work claimed under Phase 2.

## Success criteria

- Two independent providers use the same Provider Kit.
- Five users complete the full find, approve, pay and receive flow.
- At least one delayed job is recovered without a second payment.
- The code, guide, demo and evidence are public.
