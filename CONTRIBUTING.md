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

Requires **Node.js ≥ 18**. No API keys, no wallet, no `.env` needed — the defaults read Stellar **mainnet**.

Try it end to end without installing anything into a client:

```bash
node dist/index.js doctor              # self-check: env, explorer, RPC, on-chain verify
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
| `src/lib/` | Core logic: `explorer` (registry reads), `reputation` (on-chain verify), `ranking`, `sanitize`, `nlparse`, `agentcard`, `identifier` |
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
- CI runs the matrix Node 18/20/22 × ubuntu/macOS plus a `npm pack --dry-run`. Green CI is required to merge.
- User-visible changes get a `CHANGELOG.md` entry under `## Unreleased`.

## Releasing

Releases are tag-driven. Pushing a `v*` tag runs `.github/workflows/publish.yml`, which publishes to npm via
**Trusted Publishing** (OIDC — no long-lived token, provenance attached automatically) and then publishes
`server.json` to the official MCP Registry.

```bash
npm version patch    # or minor / major — updates package.json and tags
git push --follow-tags
```

Keep `version` in sync across four hand-maintained places: `package.json`, `server.json` (both the top-level
and `packages[].version`), and `metadata.version` in `skills/mcp/SKILL.md`. `test/skill-sync.test.ts` and
`test/version-sync.test.ts` enforce all four, so a missed bump is a red build rather than a bad release.

### First release — one-time setup

The tag-driven path needs two things that only exist after a first publish:

1. **The repository must be public.** npm provenance is generated from a public source, and the MCP Registry's
   GitHub OIDC login expects a public repository.
2. **A Trusted Publisher must be configured on npmjs.com** for the `stellar-agent-mcp` package, pointing at this
   repository and `.github/workflows/publish.yml`. That configuration requires the package name to exist, so the
   very first publish is manual:

   ```bash
   npm login
   npm publish --access public
   ```

   Then add the Trusted Publisher in the package settings on npmjs.com. Every release after that is just a tag
   push — no token, provenance attached automatically.

## Reporting security issues

Do **not** open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md) for the disclosure process and
the threat model.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
