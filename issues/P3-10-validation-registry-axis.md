# P3-10 — Validation registry as a fourth trust axis

**Owner:** Code · **Status:** deferred — out of SOW scope

## Idea

ERC-8004 specifies three registries: Identity, Reputation, Validation. This server reads the first two. A
fourth ranking axis backed by the Validation registry (`get_validation_status`, `get_summary`,
`get_agent_validations_paginated`) would let an agent weigh *attested* work alongside client feedback — harder
to fake than either.

## Why it is deferred

Not in SOW scope, and there is nothing to read yet: the live registry reports **`totalValidations: 0`**, and
arXiv 2606.26028 independently observed "no mainnet deployment of this component" during its collection window.

A ranking axis over an empty set adds surface area and no signal. Revisit when validations appear on mainnet.

## Notes for whoever picks this up

The explorer's HTTP API has **no** validation endpoint — these are Soroban reads only, so this axis would go
through `ReputationVerifier`'s pattern (keyless simulation) rather than `ExplorerService`.
