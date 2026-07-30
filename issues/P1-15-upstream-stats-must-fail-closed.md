# P1-15 — Upstream `/stats` must fail closed on Supabase errors

**Owner:** Upstream Stellar 8004 · **Status:** ready to file upstream

## Problem

`webapp/supabase/functions/api/handlers/stats.ts` runs nine Supabase queries in `Promise.all`, but destructures
only `count`/`data` and ignores every query's `error`. Failed exact counts become `0` through `count ?? 0`;
failed samples become empty arrays through `data ?? []`. The handler then returns an HTTP-success response
with cache headers, so an outage can look like a healthy empty registry or a valid zero distribution.

Four metrics (`totalUniqueClients`, `averageFeedbackScore`, `protocolDistribution`, `trustDistribution`) are
also computed from independently fetched, unordered samples capped at 5,000 rows. The response does not state
the sample size, cap, ordering, or lack of a shared snapshot.

The MCP now runtime-validates every stats field and maps malformed success payloads to `UPSTREAM_ERROR`, but
it cannot distinguish a syntactically valid fabricated zero from a real zero. The source API must not create
one.

## Required upstream fix

- Capture and check `error` from all nine queries before doing any aggregation.
- Return the canonical non-cacheable `QUERY_ERROR` response when any required query fails; never substitute
  `0` or `[]` for an errored query.
- Keep true empty results distinct from failures.
- Add explicit coverage metadata for sampled fields: sample cap, actual sample size, deterministic ordering,
  and snapshot/revision semantics. Until a revision-bound query exists, report snapshot consistency false.
- Document `averageFeedbackScore` units instead of implying a universal 0–100 range.

## Acceptance criteria

- [ ] A forced failure in each of the nine Supabase queries produces a non-2xx `QUERY_ERROR`, never cached 200.
- [ ] Legitimate zero counts and empty distributions still return 200 and are distinguishable from failure.
- [ ] Counts are non-negative safe integers; averages are finite; every distribution value is a non-negative
      safe integer; network is a documented enum.
- [ ] Sampled metrics include cap, actual sample size, ordering/version, and snapshot-consistency metadata.
- [ ] API, SDK, and MCP contract tests cover malformed/null/fractional/negative/non-finite values.

## Local containment

`src/lib/registry-stats.ts` rejects malformed stats/health success payloads. This is defense in depth, not a
replacement for upstream error handling because a fabricated zero is structurally valid.

