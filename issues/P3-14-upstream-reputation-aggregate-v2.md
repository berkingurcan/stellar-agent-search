# P3-14 — Upstream scalable reputation aggregate v2

**Owner:** Upstream Stellar 8004 · **Status:** filed — [trionlabs/stellar-8004#19](https://github.com/trionlabs/stellar-8004/issues/19)

## Problem

The canonical Reputation contract's `get_summary` silently processes at most five supplied client
addresses (`MAX_SUMMARY_CLIENTS = 5`). This is a necessary read-budget bound, but it means a consumer cannot
re-derive the complete reputation of an agent with more than five comparable reviewers.

Two semantic differences make a client-count shortcut unsafe:

- the canonical Supabase leaderboard excludes feedback where `client_address = agent.owner`, while
  `get_summary` includes every supplied address; and
- `get_clients_paginated` is append-only, so its length is not the active unique-client count after all of a
  client's feedback is revoked.

Passing a longer list is not a fallback: the contract truncates it, so a plausible-looking result can cover
only the first five clients. Nor can a short/empty paginated result prove the set fits: expired index slots
are skipped while later live entries may remain. The MCP therefore performs only a bounded reachability read,
does not call `get_summary`, and returns `unavailable` with
`reason: client-set-exhaustion-unprovable`, `verifiedFields: []`, and all reputation fields unverified.

## Proposed direction

Add a versioned, constant/bounded-cost read surface whose response says exactly what it covers. A candidate
shape is:

```rust
get_summary_v2(agent_id: u32, exclude_client: Option<Address>) -> SummaryV2

SummaryV2 {
  sum_wad: i128,
  count: u64,
  unique_clients: u32,
  complete: bool,
  semantics_version: u32,
}
```

The exact ABI is an upstream design decision. It must not accept an unbounded caller-controlled client list
or silently truncate. A scalable implementation likely needs maintained per-agent and per-client active
aggregates updated on `give_feedback` and `revoke_feedback`, allowing one explicitly excluded owner to be
subtracted in bounded work. Existing state migration/backfill and upgrade timelock behavior must be designed
before deployment.

If an on-chain aggregate is not feasible, expose a cryptographically verifiable commitment/proof to the
canonical indexed aggregate. A plain Supabase value is still useful indexed truth, but must remain labeled
declared rather than on-chain verified.

## Acceptance criteria

- [ ] Inputs cannot make read cost grow with total historical feedback.
- [ ] The contract never silently returns a prefix aggregate as if it were complete.
- [ ] Response semantics explicitly cover active, non-revoked feedback and active unique clients.
- [ ] Owner self-feedback inclusion/exclusion is versioned and matches the canonical leaderboard policy.
- [ ] Mixed `value_decimals`, negative values, overflow, revocation, repeated feedback per client, and an
      excluded owner have contract tests.
- [ ] Existing state has a reviewed migration/backfill plan; incomplete legacy aggregates fail closed.
- [ ] Generated SDK bindings/types are published from `trionlabs/stellar-8004` before this MCP consumes them.
- [ ] The MCP keeps its current `unavailable`/no-field behavior until a live contract + SDK canary proves the
      new response is authoritative and semantically aligned with a revision-compatible indexed projection;
      `partial`, `mismatch`, and `verified` remain future-reserved until then.

## Non-goals

- Moving reputation truth into this MCP or Cloudflare storage.
- Giving the MCP a Supabase service-role key.
- Treating reviewer breadth as Sybil proof.
- Removing the bounded read protections from the existing contract.
