# P2-17 — Align the official SDK and MCP product surfaces

**Owner:** Trion Labs web/docs owner + this repo · **Status:** partially implemented; upstream changes pending

## Problem

Users should not have to infer whether `stellar8004.com`, `@trionlabs/stellar8004`, and
`stellar-agent-search` are competitors or copies. They are separate interfaces over one canonical registry:

- the upstream SDK owns TypeScript integration, registration, and signed writes;
- this package owns read-only discovery, MCP client setup, and the terminal discovery CLI;
- the upstream indexer/Supabase/API remains the only indexed data plane.

The MCP landing now links to the canonical SDK documentation and withholds its private/unclaimed source and
install links. The reverse navigation is still missing. The inspected upstream root README also names the
stale package `@trionlabs/8004-sdk`, while its SDK README shows `SorobanClient` examples that the current SDK
does not export. Publishing cross-links before those examples are corrected would turn product clarity into a
broken onboarding path.

The upstream Supabase Studio `/mcp` must never appear in this navigation. It is a restricted database-operator
surface with SQL capabilities, not the public agent MCP.

## Fix

1. Correct the upstream README/SDK examples against the published `@trionlabs/stellar8004` exports.
2. Add a link from `stellar8004.com/developers` and the upstream README to the official MCP landing only after
   the canonical repository is public, npm ownership/provenance is verified, and the MCP install surface is
   enabled.
3. Keep the MCP landing's explicit SDK link and add a small compatibility table maintained from release data:
   Explorer API version, exact upstream SDK version, MCP version, and supported Node floor.
4. Add cross-repository contract tests for the Explorer response fields consumed by the MCP. Runtime response
   validation and service-field preservation remain owned by the upstream SDK; the MCP keeps only
   defense-in-depth validation.

## Acceptance

- Both sites route MCP/terminal users and TypeScript/write users to the correct official package.
- No public page recommends the Supabase Studio admin MCP as an agent runtime.
- Every copied SDK example imports a symbol exported by the currently published package.
- The compatibility table is generated or CI-checked, not hand-maintained marketing copy.
- A release of either package cannot silently break the API/SDK/MCP contract tests.
