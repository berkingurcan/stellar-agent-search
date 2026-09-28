# Stellar Agent Search — Phase 2: Provider Network

## Vision

Stellar Agent Search can grow from agent discovery and a reference payment loop into open infrastructure for
finding, providing, hiring and paying AI agent services on Stellar.

## What Phase 1 proved

- Agents can be discovered, ranked and inspected through MCP and CLI.
- A client can discover a registered service, validate an x402 challenge, pay USDC on Stellar mainnet, receive
  a result and write reputation feedback.
- Payment submission can fail closed, avoid automatic replay and leave durable recovery evidence.

## What remains product work

The existing funded demo is pinned to one Scrapper agent and one reviewed request. There is no reusable
provider server kit, no general client wallet runner, no standard asynchronous job/status/result contract and
no independent provider onboarding flow.

## Proposed Phase 2

### Provider Kit

A reusable service template for Stellar x402 pricing, payment verification, receipts, request identity and
Stellar 8004 service metadata.

### Independent Provider Pilot

Two external developers connect independently operated services using the same kit. Pilot evidence records
integration time, successful paid calls, failures and fixes without presenting incentives as adoption.

### Job and Result Recovery

A standard provider contract lets a client recover an interrupted paid job after a timeout or restart. The
client checks payment and job state before any new charge; uncertain payment is never automatically replayed.

### Separate Client Runner

Wallet custody, budgets, approvals and signing live in a separate client process. The Stellar Agent Search MCP
remains read-only and keyless. The Algoria hackathon prototype supplies UX lessons, not a second project identity.

## Intended outcome

The follow-on turns a secure single-provider reference flow into reusable infrastructure that independent
providers and users can adopt, while preserving the trust boundaries established in Phase 1.
