# Stellar Agent Search — Phase 2: Provider Network

## The idea in one sentence

Make it easy for developers to offer paid AI services on Stellar, and easy for users to find, hire and pay them.

## How we got here

**Stellar Agent Search** was the first project. It helps AI assistants find and evaluate agents registered on
Stellar. It is read-only and does not hold a wallet or make payments.

**Algoria** was a hackathon prototype. It tested the next step: a user could ask Claude or Codex for a service,
approve a Stellar payment and receive the result. It taught us how the buyer experience should work.

The remaining problem is the provider side. A developer still has to create the payment flow, service format
and recovery logic alone. This makes every integration different and difficult to trust.

## What Phase 2 will build

### 1. Provider Kit

Starter code and a short guide for developers. It will show them how to describe a service, set a price, accept
USDC on Stellar and return a result in a standard format.

### 2. Payment Client

A separate client will handle the user's wallet, spending limits and payment approval. Private keys will never
enter the Stellar Agent Search server.

### 3. Job Recovery

Some services take time. If a connection closes after payment, the user will be able to check the same job and
collect the result without paying again.

### 4. Independent Pilot

Two independent developers will connect real services with the same Provider Kit. Five users will test the
complete flow. The pilot will record what worked, what failed and what we fixed.

## A simple example

1. A user asks an AI assistant to make a phone call or create a TikTok video.
2. Stellar Agent Search finds a suitable service.
3. The user sees the price and approves payment.
4. The provider receives USDC and completes the work.
5. The user receives the result and can leave feedback.
6. If the job is delayed, the user can recover it without a second payment.

## What already exists and what is new

| Already built | Phase 2 work |
| --- | --- |
| Agent discovery, ranking and reputation | Reusable Provider Kit |
| 13 read-only MCP tools | Separate payment client |
| One successful mainnet payment and feedback flow | Standard job and result recovery |
| Algoria buyer-experience prototype | Two-provider and five-user pilot |

## Four-week plan

- **Week 1:** Define the service format and safe payment flow.
- **Week 2:** Build the Provider Kit and job recovery.
- **Week 3:** Connect two independent services and fix integration problems.
- **Week 4:** Test with five users and publish the demo, documentation and evidence.

## Goal

Continue Stellar Agent Search from a discovery tool into an open network where people can find, hire and pay AI
services, and where developers can earn USDC by providing them.
