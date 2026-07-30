# P1-22 — Bind leaderboard freshness to the last successful refresh

**Owner:** Upstream Stellar 8004 · **Status:** local finding; not yet filed upstream

## Problem

The canonical agent rows and the `leaderboard_scores` materialized view have different update paths. At
inspected upstream commit `d92c2f4`, contract checkpoints are updated before the end-of-run leaderboard
refresh. A refresh failure is logged and increments the run's error count, but it does not roll back those
checkpoints. The public `/health` endpoint reads only contract `indexer_state`; it does not report the
materialized view's last successful refresh/revision. Thus all three indexers can look fresh while ranking,
`minScore`, detail scores, and advanced search read an older leaderboard projection.

The two-minute refresh throttle is an intentional cost bound, but expected lag must be measurable. A recent
contract checkpoint is not a leaderboard freshness proof.

## Acceptance criteria

- [ ] Persist the last **successful** leaderboard refresh time, projection revision, and incorporated
      reputation/validation ledger watermarks.
- [ ] A skipped-by-throttle call is distinguishable from a successful refresh and from a failed refresh.
- [ ] `/health`, list/detail score responses, and discovery responses expose the leaderboard watermark used.
- [ ] Staleness compares against the oldest incorporated dependency, not the newest indexer checkpoint.
- [ ] Refresh error or excessive lag makes score-dependent filters/sorts fail closed or return an explicitly
      partial, `no-store` response; it never looks like a fresh complete ranking.
- [ ] Cache keys/ETags vary on projection revision and cannot serve an older score view under a newer
      checkpoint label.
- [ ] Tests cover refresh failure after checkpoint advancement, throttle windows, concurrent refreshes,
      backfill force-refresh, and cache behavior.

## Relationship to v2

[P3-13](P3-13-upstream-discovery-api-v2.md) requires `projectionRevision`, `asOfLedger`, and `indexedAt`.
Those values are meaningful only after this issue supplies a truthful leaderboard-specific watermark.
