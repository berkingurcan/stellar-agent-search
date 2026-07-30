# P1-16 — Upstream v1 list count query materializes the registry

**Owner:** Upstream Stellar 8004 · **Status:** ready to file upstream

## Problem

`handleAgentsList` builds the count query as:

```ts
db.from('agents').select(AGENTS_SELECT, { count: 'exact', head: false })
```

It applies filters but no range, awaits the query, discards its returned rows, and then issues a second ranged
query for the requested page. A one-row page can therefore materialize every qualifying agent once for the
count and again for the actual page. Cost and response transfer grow with registry size rather than page size.
The count query's `error` is also ignored, so failure becomes `total = 0` while a later data query may succeed.

The same fail-open pattern exists in owner/feedback count and score-enrichment reads: errors are not always
checked before `null` is treated as zero/empty. Separately, `minScore` preselects at most 500 ids, so v1 cannot
claim complete query coverage even when its page stream ends.

## Required upstream fix

- Change pure count queries to `{ count: 'exact', head: true }` and check `error`.
- Check errors on score enrichment and other required secondary queries; return `QUERY_ERROR`, never a
  plausible partial row/count response.
- Add a regression that measures returned/materialized rows for `limit=1` on a large fixture.
- Preserve honest incompleteness metadata for the 500-id `minScore` qualifier cap.
- Continue with the revision-bound cursor API in P3-13 for stable, globally complete discovery.

## Acceptance criteria

- [ ] `limit=1` does not fetch agent row bodies in the count query.
- [ ] Count and data query failures are both non-2xx `QUERY_ERROR` responses and are not cached as success.
- [ ] Reported pagination cannot say complete when the `minScore` qualifier cap may have truncated candidates.
- [ ] Owner and feedback list count/error paths have equivalent tests.
- [ ] Load tests show per-page payload and application memory bounded independently of total registry size.

## Local containment

All MCP v1 list/owner/resolve/resource coverage now reports `snapshotConsistent: false` and
`coverageComplete: false`; `paginationExhausted` records only the upstream page-stream fact. That prevents a
false completeness claim but cannot remove the upstream query amplification.

