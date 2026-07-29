# Contributing to stellar-agent-mcp

Thanks for your interest. This is a small, deliberately narrow project: a **read-only, keyless** MCP server
over the on-chain [stellar-8004](https://stellar8004.com) agent registry. The constraints below are what make
it safe to point an autonomous agent at, so please read them before opening a PR.

## Quick start

```bash
git clone https://github.com/berkingurcan/stellar-agent-mcp
cd stellar-agent-mcp
npm ci
npm run build      # tsup -> dist/
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

The published CLI supports **Node.js ≥ 22**. This repository's contributor/build toolchain requires
**Node.js `^22.18.0` or `>=24.11.0`** and `.node-version` pins the minimum supported contributor release. No API
keys, wallet, or `.env` are needed — the defaults read Stellar **mainnet**.

Try it end to end without installing anything into a client:

```bash
node dist/index.js doctor              # self-check: env, explorer, RPC, bounded contract reachability
node dist/index.js find "web scraper"  # the CLI surface
node dist/index.js                     # the MCP stdio surface (speaks JSON-RPC; Ctrl-C to exit)
```

## Project layout

| Path | What lives there |
|---|---|
| `src/index.ts` | Entry point — dispatches to the MCP server or the CLI |
| `src/server.ts` | `McpServer` wiring: tools + resources + prompts |
| `src/tools/` | One file per tool, plus `shared.ts` (cross-tool adapters) and `schemas.ts` (zod) |
| `src/resources/` | The `stellar8004://` resource layer |
| `src/prompts/` | Slash-command workflow templates |
| `src/lib/` | Core logic: `explorer` (registry reads), `reputation` (fail-closed contract probe), `ranking`, `sanitize`, `nlparse`, `agentcard`, `identifier` |
| `src/cli/` | Human terminal surface |
| `examples/` | `x402-demo.ts` — the *only* keyed code in the repo, run manually |
| `test/` | vitest suites, including the invariant tests below |
| `skills/mcp/` | `SKILL.md` — installed by `npx skills add berkingurcan/stellar-agent-mcp --skill mcp` |
| `issues/` | Open work, one file per issue — see [issues/README.md](issues/README.md) |

## Non-negotiable invariants

These are enforced by tests. A PR that breaks one will fail CI, and that is the intended behaviour — please
don't work around the test.

### 1. Read-only and keyless — `test/readonly-invariant.test.ts`

Nothing under `src/` may import a signer, build a transaction, or read a private key. `STELLAR_PRIVATE_KEY` is
**deliberately ignored** (and warned about on stderr) if present. Write operations belong in
`examples/x402-demo.ts`, which the user runs under their own explicit control.

### 2. stdout carries JSON-RPC only — `test/stdout-clean.test.ts`

An MCP stdio server shares stdout with the protocol. Every log, warning, banner, and diagnostic goes to
**stderr** via `src/lib/logger.ts`. A stray `console.log` corrupts the stream and breaks every client — use
`log.info` / `log.warn` / `log.error`.

### 3. The trust boundary — `test/injection.test.ts`

The registry is permissionless, so agent-authored text (names, descriptions, service labels, feedback tags) is
**untrusted input**, and our consumer is usually another model. Therefore:

- **Server-authored prose** (`content[].text`) may interpolate only typed values — numbers, enums, ids, booleans.
  This is compile-enforced by the `serverText` tagged template in `src/lib/sanitize.ts`; a raw `string` will not
  typecheck. Use `safe()` only for values you have validated.
- **Agent-authored text** lives only in labelled `selfDeclared` slots of `structuredContent`, passed through
  `sanitizeText()` (strips control, zero-width, bidi, and line/paragraph separators) and length-bounded.

If you add a field that carries registry text, it goes in a `selfDeclared` slot. No exceptions.

### 4. Degrade closed, never fake

If Soroban RPC is unreachable, verification reports `unavailable` — it must never fall back to reporting the
indexer's declared number as if it were verified. Same for an unrated agent: absence of data is not `verified`.

## Adding a tool

1. Create `src/tools/<name>.ts` exporting `register<Name>(server, deps)`.
2. Define input/output schemas in `src/tools/schemas.ts` (zod). Give every field a `.describe()` — model clients
   read those descriptions.
3. Reuse the shared adapters in `src/tools/shared.ts` (`buildAgentProfile`, `toRankedRow`, `filterMpp`) rather
   than re-fetching; they already handle verification, wallet validation, and rounding.
4. Register it in `src/tools/index.ts`.
5. Add it to the table in `README.md`, write the full entry in `docs/tools.md`, and document it in
   `skills/mcp/SKILL.md` (both places that spell the tool count out loud). You do not have to remember this:
   `test/skill-sync.test.ts` fails if the skill and `src/` disagree, and names what is missing.
6. Add tests. If the tool emits summary text, add an injection case.

Consider whether the same data should also be a `stellar8004://` resource — tools are for actions, resources are
for pinnable context, and the two surfaces should not disagree.

## Testing

```bash
npm test              # once
npm run test:watch    # watch mode
```

Tests must not hit the network. Explorer and RPC calls are injected through `ToolDeps`, so pass a fake. If you're
fixing a bug, add the failing case first — `test/fixes.test.ts` collects regression cases by defect.

## Commits and pull requests

- Conventional-commit prefixes: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.
- One logical change per PR; explain **why**, not just what.
- Before pushing: `npm run typecheck && npm test && npm run build`.
- CI runs the matrix Node 22/24 × ubuntu/macOS plus a `npm pack --dry-run`; the Worker gets a separate
  Node 22 typecheck/test/bundle audit. Green CI is required to merge.
- User-visible changes get a `CHANGELOG.md` entry under `## Unreleased`.

## Releasing

Releases are tag-driven. Pushing a `v*` tag runs `.github/workflows/publish.yml`, but only when the tagged commit
is already on `main`. The job repeats typecheck, tests, build, package/manifest validation, and an isolated
tarball-consumer install before it publishes to npm via **Trusted Publishing** (OIDC — no long-lived token).
It verifies the resulting npm tarball and SLSA provenance before publishing `server.json` to the official MCP
Registry. Exact-version checks make a rerun resumable without treating an unrelated package or immutable
registry record as ours.

```bash
npm version patch --no-git-tag-version  # or minor / major; do not tag yet
# Update server.json, skill metadata, Smithery, pinned docs/web examples, and CHANGELOG.md.
npm ci && npm run validate:release && npm run typecheck && npm test && npm run build
# Review and commit only the complete release diff, then wait for green main CI.
git tag vX.Y.Z
git push origin vX.Y.Z
```

Keep `version` in sync across `package.json`, `server.json` (both the top-level and `packages[].version`), and
`metadata.version` in `skills/mcp/SKILL.md`. Also update `smithery.yaml` and every persistent onboarding example
to the same exact `stellar-agent-mcp@X.Y.Z` pin. `test/skill-sync.test.ts`, `test/version-sync.test.ts`, and the
release validator enforce the machine-readable surfaces; review the complete pinned-command search before tagging.

### First release — one-time setup

**Mandatory first-release order:** private move to selected owner `berkingurcan` → inert `0.0.0` reservation under
the non-default `bootstrap` tag while private → public repository → protected OIDC real release.

Do not swap the middle steps: making prepared `npx` commands public while the npm name is unclaimed creates a
supply-chain takeover window, while a real provenance-backed publish requires the final repository to be
public. Execute the one-time setup in this order:

1. **Move the private repository to the selected canonical owner.** The chosen identity is
   `berkingurcan/stellar-agent-mcp`. Transfer the existing repository if possible so history and settings stay
   intact; otherwise create the private destination and push the complete history. Validate every
   repository/MCP/npm identity-bearing file before reserving npm or making the destination public.
2. **Reserve the name while the repository is still private.** Trusted Publisher configuration requires the
   package to exist. Generate an inert `0.0.0` package outside the repository: it contains only
   `package.json`, `README.md`, and `LICENSE`, while its `publishConfig` forces the non-`latest` `bootstrap`
   dist-tag. Inspect and publish that placeholder, not a version-rewritten copy of the real runtime:

   ```bash
   npm ci
   npm run validate:release
   npm run typecheck
   npm test
   npm run build
   bootstrap_dir="$(mktemp -d)"
   node scripts/release/create-bootstrap-package.mjs "$bootstrap_dir"
   npm pack --dry-run "$bootstrap_dir"
   npm login
   npm publish "$bootstrap_dir" --access public --tag bootstrap
   npm view stellar-agent-mcp dist-tags --json
   ```

   Do not publish `0.1.0` manually: that release must come from OIDC so it has verifiable provenance.
3. **Only after the inert reservation is independently visible, make the canonical repository public.** Verify
   logged-out source access and confirm the repository identity still matches the reserved package owner.
   npm provenance and MCP Registry GitHub OIDC require this public source.
4. **Configure and protect npm Trusted Publishing.** Create and protect GitHub environment
   **`npm-production`** first. Then, in npm package settings, select GitHub Actions, the exact canonical
   owner/repository chosen in step 1, and workflow filename **`publish.yml`** (the npm field takes the filename,
   not `.github/workflows/publish.yml`). Set environment name **`npm-production`** and allow `npm publish` only.
   Restrict token publishing after the OIDC path succeeds.
5. **Set the repository Actions variable `NPM_PACKAGE_OWNERS`.** Its comma-separated value must be the exact
   npm maintainer allowlist (usually the one account that performed the bootstrap). The workflow refuses both
   a missing variable and an unexpected extra owner.
6. **Verify the `npm-production` protection.** Require a second reviewer, prevent self-review, allow
   only selected tags matching `v*`, and disable administrator bypass. A YAML environment reference alone does
   not create those rules; a solo maintainer needs a second trusted repository reviewer.

Then create/push `v0.1.0` from a green commit already on `main`. The workflow publishes the exact tarball it
tested, verifies its registry integrity and GitHub provenance, and only then attempts the MCP Registry record.
After both registry records are independently readable, follow
[`issues/P0-03-first-npm-publish.md`](issues/P0-03-first-npm-publish.md#3-verify-first-then-expose-onboarding):
switch `web/src/lib/install.ts` from the pending to the published re-export in a reviewed follow-up, then build
and run the release-surface scan before deployment. This keeps executable package commands out of pre-release
JavaScript entirely. Keep persistent MCP launches exact-version pinned.

## Reporting security issues

Do **not** open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md) for the disclosure process and
the threat model.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
