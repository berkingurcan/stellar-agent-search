# Publishing `stellar-agent-mcp`

Operational runbook for the first release and every one after it.

The repo already tracks the *why* for the blocking items in [`issues/`](issues/) — this file is the
ordered sequence and the checks that tell you a step actually worked. Where an issue covers a step,
it is linked rather than restated.

**State verified 29 July 2026:**

| | |
|---|---|
| npm package | **does not exist** — `npm view stellar-agent-mcp` → 404 |
| GitHub repo | **private** — `gh repo view --json visibility` → `PRIVATE` |
| Current branch | `fix/issues-sweep` (default branch is `main`) |
| Working tree | dirty, including dependency changes (`zod ^3→^4`, MCP SDK `2.0.0`, `engines >=18→>=20`) |
| Tests | 161 passing across 15 files |
| Version | `0.1.0`, consistent in `package.json` and `server.json` (both the top-level and `packages[0]` fields) |

Everything on the landing page and in the README — `npx -y stellar-agent-mcp …` — fails until step 3
completes.

---

## The shape of this

Releases are **tag-driven**. `.github/workflows/publish.yml` fires on any `v*` tag and does the whole
job: `npm ci` → build → test → `npm publish` → publish the manifest to the MCP Registry.

It authenticates with **npm Trusted Publishing** (OIDC), so there is no `NPM_TOKEN` anywhere. That is
also why the first release cannot use it: a Trusted Publisher is configured in a package's settings
page on npmjs.com, and the package has to exist before it has a settings page.

So the first release is manual, and it exists to create the name. Every release after it is a tag.

---

## 1. Make the repository public

Settings → General → Danger Zone → Change visibility → Public.

This is not cosmetic and it is not optional-for-now. npm's own documentation:

> Provenance is not generated for packages in private repositories, even when using trusted
> publishing. This limitation applies whether the package itself is public or private.

Publish while private and the package ships with no provenance attestation, which is one of the
things a reviewer is asked to check.

[`issues/P0-01-make-repository-public.md`](issues/P0-01-make-repository-public.md) lists the three
`docs/evidence.md` edits that become false the moment visibility flips. Do them in the same pass.

**Check:** open `https://raw.githubusercontent.com/berkingurcan/stellar-agent-mcp/main/skills/mcp/SKILL.md`
in a private window. It must return the file, not a 404. Until it does,
`npx skills add berkingurcan/stellar-agent-mcp --skill mcp` cannot resolve either.

## 2. Get `main` into a releasable state

The tag has to point at the commit you actually want published, and CI runs from the tag — not from
your working tree.

```bash
git status --short                 # must be empty
npm ci                             # clean install from the lockfile, as CI does
npm run typecheck && npm test      # 161 tests
npm run build
```

The working tree currently carries in-flight dependency changes. `npm ci` installs from
`package-lock.json`, so if the lockfile and `package.json` disagree it fails outright — fix that
before tagging rather than discovering it in the workflow.

Then set the release date. `CHANGELOG.md` line 107 reads `## [0.1.0] — unreleased`; replace
`unreleased` with the date, and fold anything still sitting under `## [Unreleased]` into it.

Merge to `main` and confirm you are on it — a tag on `fix/issues-sweep` publishes that branch's code.

```bash
git branch --show-current          # main
```

**Version consistency.** Three fields must match or the MCP Registry rejects the manifest:

```bash
node -p "require('./package.json').version"
node -p "require('./server.json').version"
node -p "require('./server.json').packages[0].version"
```

## 3. First publish — manual, once

```bash
npm login
npm publish --access public
```

`prepack` runs the build for you, so `dist/` is rebuilt from the committed source rather than
whatever was last in your working tree.

Before you run it, `npm publish --dry-run` prints the tarball. It should be **6 files, ~147 kB**:
`LICENSE`, `README.md`, `package.json`, `dist/index.js`, `dist/index.js.map`, `dist/index.d.ts`.
The `files` field restricts the package to `dist/`, `README.md` and `LICENSE`, so `web/`, `test/`,
`examples/`, `issues/` and `docs/` are correctly absent.

The dry-run must print **no** `npm warn publish` lines. It used to emit:

```
npm warn publish "bin[stellar-agent-mcp]" script name dist/index.js was invalid and removed
```

`bin` is the entire product — if npm drops it, `npx -y stellar-agent-mcp` resolves to nothing. Fixed
by writing the path without the `./` prefix (`"dist/index.js"`, what `npm pkg fix` produces); the
warning is gone and the packed tarball keeps both `bin` and the `#!/usr/bin/env node` shebang. If the
warning ever comes back, stop and fix it before publishing.

**Check:**

```bash
npm view stellar-agent-mcp version
cd /tmp && npx -y stellar-agent-mcp doctor
```

`doctor` is the right smoke test: it reports Node version, network, and the read-only/keyless
invariant, so a green run proves the binary resolved *and* the environment is sane.

## 4. Configure the Trusted Publisher

On npmjs.com → the package → Settings → Trusted Publisher:

- Provider: **GitHub Actions**
- Organization / user: `berkingurcan`
- Repository: `stellar-agent-mcp`
- Workflow filename: `.github/workflows/publish.yml`

A package can hold only one trusted publisher at a time. Once this is set, no long-lived token is
needed and provenance is attached automatically on every subsequent release.

Covered by [`issues/P0-03-first-npm-publish.md`](issues/P0-03-first-npm-publish.md).

## 5. Every release after this one

```bash
# bump package.json + server.json (×2) to the new version, date the CHANGELOG section, commit
git tag v0.1.1
git push origin v0.1.1
```

The workflow needs `id-token: write` for **both** npm Trusted Publishing and the MCP Registry's
GitHub OIDC login — it is already set at the job level; do not narrow it.

**Check:** the npm page shows the repository link and a **provenance** badge, and the run's
`mcp-publisher publish` step succeeds. The MCP Registry entry is keyed on
`io.github.berkingurcan/stellar-agent-mcp` and points at the npm package by `identifier` +
`version` — which is why the version fields in step 2 have to agree.

---

## Things worth knowing before you press publish

**Publishing a name is close to permanent.** Unpublishing is only allowed within 72 hours, and the
name stays reserved afterwards. Publish `0.1.0` only when it is the thing you want people to install.

**Node version.** Trusted Publishing needs Node ≥ 22.14 and npm ≥ 11.5.1. The workflow pins Node 22
and upgrades npm before publishing. Your local Node only matters for step 3.

**`npm publish --dry-run` does not exercise provenance generation.** A missing or malformed
`repository.url` surfaces only on a real publish, which is another reason the first one is manual
and attended.

**The landing page is already live** at <https://mcp.stellar8004.com> and advertises the install
command. It went out before the package did, so the gap between now and step 3 is publicly visible.
