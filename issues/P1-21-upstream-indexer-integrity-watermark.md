# P1-21 — Expose a durable indexer integrity watermark

**Owner:** Upstream Stellar 8004 · **Status:** local finding; not yet filed upstream

## Problem

The upstream indexer deliberately has liveness escape hatches: after repeated write failures, or when RPC
retention prevents replay, it can advance a checkpoint past an event/range and call `recordDeadLetter`.
At inspected commit `d92c2f4`, dead-letter insertion is best-effort: its own failure is logged and swallowed so
the checkpoint can still advance. The public health response exposes only `lastLedger` and a time-based
`stale` flag. A recently advancing indexer can therefore report healthy even when it skipped data, failed to
record the skip, detected a gap, or is rebuilding from a cold/missing checkpoint.

These are defensible liveness choices only if projection integrity is independently durable and visible.
Freshness is not integrity.

## Acceptance criteria

- [ ] Checkpoint advancement and the durable record of every skipped event/range have an atomic or fenced
      relationship; inability to record the integrity loss prevents a `complete` watermark.
- [ ] State distinguishes cold start, replaying, complete, deferred, gap detected, retention-clamped,
      dead-lettered, and integrity unknown.
- [ ] A monotonic projection revision binds contract name/address, network, processed-through ledger,
      expected next ledger, and integrity state.
- [ ] Rewinds, contract-address changes, missing checkpoint rows, and ledger regression are detected rather
      than normalized to zero.
- [ ] `/health` exposes safe aggregate integrity fields and returns degraded when any canonical projection is
      incomplete; internal event payloads remain private.
- [ ] Discovery responses carry the exact revision/integrity watermark used for their rows.
- [ ] Backfill/reconciliation can clear degradation only after proving the affected range was replayed.
- [ ] Tests cover dead-letter-write failure followed by checkpoint update, retention gaps, repeated deferred
      writes, checkpoint regression, and process races.

## Local containment

The MCP exposes upstream staleness and never claims v1 snapshot completeness. It cannot reconstruct skipped
events or prove projection integrity from the current API, and must not run a second indexer to try.
