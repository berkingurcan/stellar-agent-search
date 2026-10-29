# P3-10 — Validation registry as a fourth trust axis

**Owner:** Code · **Status:** partly implemented — `get_provider_manifest` reads the Validation Registry for Provider
Standard badges; a ranking axis is still deferred

## Idea

ERC-8004 specifies three registries: Identity, Reputation, Validation. This server reads the first two. A
fourth ranking axis backed by the Validation registry (`get_validation_status`, `get_summary`,
`get_agent_validations_paginated`) would let an agent weigh *attested* work alongside client feedback — harder
to fake than either.

## What exists now

Stellar Agent Services' Provider Standard v1 gives Validation Registry records a meaning: a verifier answers a
provider's request with `response` = the conformance score (0/33/67/100 for levels 0–3) and tag
`provider-standard-v1`. `get_provider_manifest` (`src/lib/validation.ts`) reads those records:

- only for validators the operator lists in `TRUSTED_VALIDATORS`, and never for a validator that is the agent's
  own owner or wallet;
- `get_summary` first, so an agent with no trusted record costs one simulation; then a bounded scan of the
  agent's request hashes and statuses, newest first;
- fail-closed: any failed read is `unavailable`, never a partial set of badges.

The level badges (Standard v1, Payment verified, Recovery verified) come from the score alone. Load-safe and 8004
validated need the receipt behind `response_hash`; see [P3-24](P3-24-provider-receipt-badges.md).

## Why the ranking axis is still deferred

The ranking policy `stellar-agent-search-declared-evidence-v1` is versioned, so an axis means a new `rankVersion`.
Mainnet still reports **`totalValidations: 0`**, and arXiv 2606.26028 independently observed "no mainnet
deployment of this component" during its collection window. A ranking axis over an empty set adds surface area
and no signal. Revisit when trusted validators publish on mainnet.

## Notes for whoever picks this up

The explorer's HTTP API has **no** validation endpoint — these are Soroban reads only, through the fetch-only
`ValidationReadClient` in `src/lib/soroban.ts` (keyless simulation), not `ExplorerService`. Reuse
`ValidationEvidenceReader` rather than reading the contract a second way.
