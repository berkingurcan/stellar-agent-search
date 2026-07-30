# P1-20 — Upstream rate limiter must not fail open

**Owner:** Upstream Stellar 8004 · **Status:** local finding; not yet filed upstream

## Problem

At inspected upstream commit `d92c2f4`, `supabase/functions/_shared/rate-limit.ts` explicitly returns
`{ allowed: true }` when the `check_rate_limit` RPC errors, returns no data, or returns an empty array. That
turns a database outage, permission regression, or RPC/schema mismatch into an unlimited public API. The
newer SQL migration hardens the function's input/privileges, and the API maps invalid IPs to a sentinel
bucket, but neither changes this TypeScript fail-open fallback.

The remote MCP has its own independent Cloudflare admission limiter. That is defense in depth, not a fix for
the canonical Explorer API, which is also publicly reachable without the MCP.

## Acceptance criteria

- [ ] Limiter RPC errors, empty/malformed results, and non-boolean `allowed` values return a typed 503/429 and
      never invoke the requested API handler.
- [ ] The failure response is `no-store` and contains no internal database detail.
- [ ] A shallow operational health route may use a separately documented policy, but it cannot make
      data-heavy endpoints fail open.
- [ ] Tests cover database outage, timeout, permission denial, schema mismatch, malformed rows, and invalid
      forwarded-IP input.
- [ ] Metrics distinguish denied-by-budget from limiter-infrastructure failure without logging raw IPs.
- [ ] Public HTTP, reverse-proxy, and Service Binding paths cannot supply a spoofed identity that creates a
      fresh bucket.

## Non-goal

Cloudflare's PoP-local limiter is not a globally exact quota and must not be described as one. This issue is
about preventing an infrastructure failure from disabling admission control entirely.
