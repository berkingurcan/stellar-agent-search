# P1-18 — Upstream must attest the exact registry contracts

**Owner:** Upstream Stellar 8004 · **Status:** local finding; not yet filed upstream

## Problem

The live v1 list and detail responses checked on 2026-07-29 include `meta.chain = "stellar"` and
`meta.network = "mainnet"`, but no Identity, Reputation, or Validation contract address. That prevents a
consumer from distinguishing the canonical registry from another registry deployed on the same network.
The MCP currently constructs Stellar handles with the contract addresses from its pinned SDK config; neither
the hostname nor a matching network label proves that the returned rows were indexed from those contracts.

This is especially important for an overridden `EXPLORER_BASE_URL` and for a Cloudflare Service Binding:
transport routing proves which Worker received the request, not which contracts populated its database.

## Local containment

`ExplorerService` now runtime-validates agent rows and recognizes only explicit response-level
`meta.contracts.identity` or `meta.identityContract` as an Identity attestation. If supplied, the value must
exactly match the configured SDK contract or the read fails closed. If omitted, `identityAttestation()` says
`unattested`; it does not infer success. Ordinary v1 discovery remains available during migration because the
live API cannot yet satisfy a required-address gate.

This containment does **not** fix the upstream omission and does not authenticate Reputation or Validation.

## Required upstream contract

- Every successful API response includes a versioned, response-level `meta.contracts` object with exact
  Identity, Reputation, and Validation C-addresses plus the normalized network/passphrase identifier.
- Metadata is produced from the same immutable deployment configuration used by the indexer, not from a
  caller-controlled header or database row.
- Startup refuses an incoherent combination of network, passphrase, contract addresses, and indexer state.
- Public HTTP and Service Binding responses expose identical contract metadata.
- The SDK publishes typed fields without coercion and tests wrong, missing, malformed, and contradictory
  addresses.
- Deployment canaries compare all three addresses against the pinned release manifest.
- After an announced compatibility window, the MCP remote production gate requires the exact metadata;
  missing identity is then an upstream scope error rather than a tolerated v1 limitation.

## Non-goals

- Copying registry state into this repository.
- Treating an API assertion as on-chain reputation verification.
- Giving the MCP a Supabase credential.
