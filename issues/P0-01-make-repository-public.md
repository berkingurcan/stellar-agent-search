# P0-01 — Move to the selected canonical owner; reserve npm; then make it public

**Owner:** Builder + current repository owner + Berkin Gürcan · **Blocks:** everything reviewer-facing, 05 ·
**Status:** resolved 30 July 2026 — `berkingurcan/stellar-agent-search` is public with default branch `main`, verified from a logged-out session

## Problem

The source is still private under the staging path `berkingurcan/stellar-agent-search`. The SOW requires a
**public** MIT repository, and the builder has selected `berkingurcan/stellar-agent-search` as the permanent
independent MCP repository.

Verified 2026-07-29: GitHub reports the source as private with default branch `main`; the public
`berkingurcan/stellar-agent-search` path does not resolve. The authenticated contributor can push to the source
but is not its administrator, and Berkin is not yet a collaborator, so an owner must perform the transfer or
Berkin must create the private destination and grant access.

This is not only a visibility toggle. npm provenance, the MCP Registry name, Trusted Publisher settings,
security-advisory links, skill-install commands, and every repository URL currently bind to the personal
owner. Publishing first and moving later creates an avoidable identity migration.

## Selected ownership decision

The canonical identity is now fixed:

- GitHub: `berkingurcan/stellar-agent-search`
- MCP Registry: `io.github.berkingurcan/stellar-agent-search`
- npm: unscoped `stellar-agent-search`

Prefer transferring the existing private repository because it preserves commit history, Actions history,
settings, and redirects. If account or GitHub policy prevents transfer, Berkin may create the private target
and the complete Git history may be pushed there, but the old repository must then be archived or clearly
marked non-canonical before anything becomes public.

This is an independent adapter repository, not a claim that Trion Labs publishes or supports it. The upstream
`trionlabs/stellar-8004` repository remains canonical for contracts, indexer, Supabase, Explorer API, and SDK.

Do not copy the SDK into this repository. The upstream repository remains canonical for contracts, generated
bindings, Explorer API types, indexer, and Supabase migrations; this package already consumes its exact npm
release. A later monorepo move is optional organization work, not a runtime integration requirement.

## Impact while unresolved

- Every link in [docs/evidence.md](../docs/evidence.md) 404s for a reviewer who is not a collaborator.
- The Deliverable-3 `npx skills add ... --skill mcp` command cannot fetch the skill anonymously.
- npm provenance and MCP Registry publication remain blocked.
- Local identity-bearing files can target Berkin now, but no target URL is reviewer-verifiable until the move.

## Ordered fix after the owner is chosen

**Mandatory first-release order:** private move to selected owner `berkingurcan` → inert `0.0.0` reservation under
the non-default `bootstrap` tag while private → public repository → protected OIDC real release.

Use GitHub's repository transfer flow with the current repository owner and Berkin, and verify the destination
and redirects **while the repository remains private**. Do not make either source or destination public during
the handoff. If using a new private destination instead, first verify that Berkin owns it and that its `main`
contains the exact complete history.

After a transfer, update every identity-bearing surface before the first tag:

- `package.json` repository/homepage/bugs and `mcpName`;
- `server.json` name, website, and repository;
- `.github/workflows/publish.yml` expected provenance repository;
- the expected npm Trusted Publisher owner/repository and protected-environment identity in release docs and
  workflow validation (configure the external publisher only after public visibility);
- README badges, `SECURITY.md`, `CONTRIBUTING.md`, docs, skill-install commands, and release verification tests.

Run `rg --hidden -n 'berkingurcan|io\.github\.berkingurcan|trionlabs/stellar-agent-search' . --glob
'!node_modules' --glob '!dist' --glob '!.git'` and review every remaining match. Historical staging references
must be explicitly labelled; public commands and machine-readable identities must name only `berkingurcan`.

Next execute only the inert `0.0.0` bootstrap portion of [P0-03](P0-03-first-npm-publish.md) and independently
confirm that the intended npm owner controls the name, `bootstrap: 0.0.0` exists, and no `latest` tag exists.
Only then change repository visibility to Public. The source contains exact future `npx` commands; publishing
it while the npm name is unclaimed would advertise a namespace another party could claim and execute.

After either path becomes public, remove the private-repository warning and flip the affected evidence rows in
`docs/evidence.md`. Also add a concise repository description and relevant topics. Then configure and protect
the GitHub `npm-production` environment and npm Trusted Publisher before creating the real release tag; public
visibility does not authorize an unprotected or manual `0.1.0` publish.

## Acceptance

```bash
canonical_owner=berkingurcan
curl -sI "https://raw.githubusercontent.com/${canonical_owner}/stellar-agent-search/main/skills/mcp/SKILL.md" | head -1
# HTTP/2 200

npx skills add "${canonical_owner}/stellar-agent-search" --skill mcp
```

The canonical GitHub repository is public only after the inert npm reservation is owned and `main` is default.
After the visibility change, anonymous raw-file access succeeds, repository metadata/MCP identity name that
same owner, `docs/evidence.md` contains no private-repository banner, and the protected Trusted Publisher is
configured before the real release tag.
