# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `CONTRIBUTING.md` — contribution notes, project layout, and the four enforced invariants.
- This changelog.
- CI / npm / license badges in the README.
- `docs/evidence.md` — deliverable-to-evidence map for reviewers.
- `docs/recordings.md` — shot-by-shot scripts for the demo recordings.
- `ReputationVerifier.probe()` — an uncached read that reports *why* a verification produced no value
  (`disabled` / `truncated` / `contract-error` / `out-of-range` / `rpc-error`).
- `test/skill-sync.test.ts` — fails the build when `skills/mcp/SKILL.md` drifts from `src/`: tool, resource and
  prompt counts, unregistered tools/resources/prompts cited by the skill, registered tools it fails to document,
  and its version pin. The skill is fetched off the default branch by `npx skills add`, so drift reaches users
  with no release step in between.
- `repository`, `homepage`, `bugs`, and `keywords` in `package.json`. npm binds provenance attestations to
  `repository.url`, so publishing under Trusted Publishing would have failed without it.
- `test/version-sync.test.ts` — fails the build when the MCP SDK version advertised in the `doctor` banner, the
  README badge and prose, `docs/architecture.md`, or the sample output in `docs/getting-started.md` drifts from
  the pinned dependency, and checks the advertised spec date against the SDK's own `LATEST_PROTOCOL_VERSION`.
- `test/onchain-constants.test.ts` — asserts the USDC SAC address and CAIP-2 chain id the AgentCard advertises
  match `@x402/stellar`'s published constants. Those two values tell an A2A/AP2 client which asset on which
  chain to pay, so a hand-copied address that drifts sends a real payment to the wrong contract.
- `stellar-agent-mcp setup` — an idempotent bootstrap for Claude Code, Cursor, and Codex with `user`/`project`
  scopes, non-mutating `--check` and `--dry-run` modes, machine-readable `--json`, and an optional live MCP
  handshake that lists all tools. Existing conflicting registrations are reported, never overwritten; Codex
  project scope emits exact manual TOML because its CLI cannot persist that scope.
- MCP SDK v2 (`@modelcontextprotocol/server` + `@modelcontextprotocol/client` `2.0.0`, Zod 4) with one
  request-neutral `buildServer()` factory shared by local stdio and edge transports. The v1 monolithic SDK is
  retained only as a development peer required by Cloudflare's Agents adapter; application source never
  imports it.
- A separate Cloudflare Streamable HTTP Worker for `/mcp` and `/healthz`. The landing assets Worker continues
  to own `mcp.stellar8004.com`; exact zone routes select the runtime Worker only for those two paths. Registry
  reads cross a Service Binding to the existing `stellar8004-web` API — there is no direct Supabase client,
  service-role key, or second indexer.
- A versioned upstream discovery contract and rollout plan in `docs/stellar8004-integration.md`, filed as
  [`trionlabs/stellar-8004#18`](https://github.com/trionlabs/stellar-8004/issues/18). Until upstream accepts and
  ships it, bounded v1 scans expose explicit coverage metadata instead of pretending to be globally complete.
- Strict x402 dry-run and funded-run preflights: pinned agent/payee/network/asset/price, no permissive fallback
  retry, transaction/result hash validation, and feedback validation. A dry run spends nothing and cannot be
  presented as funded evidence.

### Security

- **On-chain reads no longer use axios.** `ReputationVerifier` now talks to the Reputation contract through
  `@stellar/stellar-sdk/no-axios/contract` (fetch-based), reusing the generated bindings' `Spec` so argument
  encoding and result decoding are unchanged — see `src/lib/soroban.ts`. Unlike the `overrides` below, this
  **does** reach consumers of the published package: verified by uninstalling the override, leaving the
  vulnerable `axios@1.15.0` in the tree, and watching `doctor`'s on-chain verification pass through a proxy
  that previously answered `405`.
- `overrides: { "axios": "1.18.1" }` — `@stellar/stellar-sdk@15.1.0` pins axios to the exact version `1.15.0`,
  which carries two **high**-severity advisories. The override removes that vulnerable version from this
  repository's resolved graph. The same bump crosses the 1.16.1 proxy fix, so `doctor`'s on-chain verification, which
  previously failed with `405` behind a proxy, now passes. **Note:** npm applies `overrides` only from the root
  project, so this protects the repository and its CI, not consumers of the published package — see
  [docs/architecture.md](docs/architecture.md).
- `overrides: { "@hono/node-server": "^2.0.5" }` forces the patched line for the legacy SDK peer graph. The
  application uses neither its static-file handler nor the monolithic SDK at runtime, but the dependency graph
  is still patched rather than excused as unreachable.
- GitHub Actions are pinned to commit SHAs in CI and release workflows rather than mutable major-version tags.
- The release workflow checksum-pins `mcp-publisher` `v1.8.0` instead of downloading `latest`, and generates a
  runtime CycloneDX SBOM as a release-workflow artifact before publishing.
- The Trusted Publishing workflow installs exact `npm@11.17.0` rather than executing a moving `npm@latest`.
- Persistent MCP client registrations created by `setup` pin the exact running package version instead of
  executing a mutable npm `latest` tag on every launch. The public landing withholds copyable install commands
  while the npm name remains unclaimed.
- Release publishing now requires main-branch ancestry, the exact npm maintainer allowlist, a schema-valid MCP
  manifest, and one packed tarball shared by consumer-SBOM generation and `npm publish`. A published version is
  skipped only when its integrity and GitHub OIDC/SLSA provenance match the tagged commit; immutable MCP
  Registry versions receive the same exact-metadata precheck. Publisher credentials are removed on every exit.

### Changed

- The skill now ships from this repository at `skills/mcp/SKILL.md` (was `skill/SKILL.md`, destined for
  `trionlabs/stellar-8004`). Install with `npx skills add berkingurcan/stellar-agent-mcp --skill mcp`.
  Rationale: [docs/evidence.md §3](docs/evidence.md).
- The skill's `mcp-package-version` pin is `>=0.1.0`, not `^0.1.0`. A caret range on a 0.x package resolves to
  `>=0.1.0 <0.2.0`, so the pin would have excluded the next minor release.
- README and the getting-started guide now use the canonical `stellar-agent-mcp setup` bootstrap instead of
  hand-written client registration commands, and the guide documents the optional skill install it had been
  missing.
- The tag release workflow now rejects tag/package/server version drift and can resume the MCP Registry phase
  after npm publication already succeeded, rather than attempting to republish an immutable npm version.
- The npm artifact is explicitly bin-only. The old `main`/`module`/`types`/`exports` fields pointed imports at
  the CLI entry, whose top-level dispatch starts a process instead of exposing a library API. SDK ownership
  remains with `@trionlabs/stellar8004`; this package now advertises only the executable it actually supports.

### Fixed

- Cached on-chain verification results retain the timestamp of the actual Soroban read. A 10-minute-old cache
  hit no longer rewrites `verification.checkedAt` to the current response time and masquerades as fresh.

- **`examples/x402-demo.ts` demanded a facilitator credential it never uses.** `X402_API_KEY` was a *fatal*
  mainnet preflight check, so a funded run would have aborted before money moved over a value nothing in the
  file reads — this client signs the payment locally and submits it as a header, and the resource server
  settles with whichever facilitator it chose. Confirmed against the live challenge from
  `scrapper.stellar8004.com`, which names no facilitator. The check is gone; the variable stays in the
  secret-exclusion assertion so a stray value still cannot reach the MCP subprocess.
- **The x402 demo signed whatever the 402 challenge asked for.** Only `network` was checked, but the resource
  server writes the whole challenge — `asset` and `amount` were equally under its control and
  `createPaymentPayload` would have signed them. The demo now also requires the asset to be the USDC SAC
  `@x402/stellar` publishes, refuses a `payTo` equal to the payer, and caps the price at `MAX_PRICE_USDC`
  (default `0.10`; the scrapper's live price is `0.0001`). The USDC address is now imported from
  `@x402/stellar` instead of re-typed — `src/` still hardcodes it to stay keyless, pinned by
  `test/onchain-constants.test.ts`.
- `examples/` and `test/` are now typechecked. `tsconfig.json` included only `src`, so `npm run typecheck` in
  CI never looked at the demo — the one file that spends real money. Adding them surfaced one latent error
  (`RequestInfo` in `test/explorer.test.ts` needs the DOM lib, which this project does not enable).
- `STELLAR_NETWORK=testnet` silently mixed two chains. The default explorer indexes mainnet only, but
  `STELLAR_NETWORK` also selects the Soroban contracts and RPC, so testnet gave mainnet registry rows with
  testnet on-chain reads and said nothing. It now **refuses to start** unless `EXPLORER_BASE_URL` is set
  explicitly — there is no public testnet indexer to fall back to, so a warning would have left the mixed
  result in place. The refusal is a `ConfigError`, printed as a plain `error:` line with exit code 2 rather
  than a stack trace, matching how a bad CLI flag already fails. The documented dry-run gate for the x402 demo
  is now `DRY_RUN=1` on mainnet, which spends nothing and exercises the path the funded run actually takes.
  (The x402 demo was never at risk — it compares the 402 challenge's network to the configured CAIP-2 id and
  aborts on a mismatch.)
- `doctor` reported a **failed** on-chain read as a passing check with the message "sampled agent #10 has no
  on-chain summary yet". It called `verify()`, which degrades closed to `null`, making a broken RPC path
  indistinguishable from an unrated agent — so a misconfigured environment showed green and exited 0. It now
  uses `probe()`, fails the check, prints the underlying cause, and exits non-zero. The degrade-closed contract
  that tools rely on is unchanged.
- The skill file listed 12 tools (there are 13) and documented a `stellar8004://search/{query}` resource that
  does not exist, plus two inaccurate resource descriptions. `test/skill-sync.test.ts` now makes this class of
  drift a red build.
- The skill declared `version: 1.0.0` against a `0.1.0` package.
- `docs/evidence.md` overstated three things a reviewer would have checked: that the skill ships inside the npm
  tarball (it does not — `files` excludes `skills/`, deliberately), that one-command skill acquisition was
  already verifiable (it needs the repo public and `main` as the default branch), and the automated test count.

## [0.1.0] — 2026-07-29

First public release: a read-only, keyless MCP server and CLI over the on-chain stellar-8004 agent registry on
Stellar mainnet.

### Added

**MCP tools (13, all read-only)**

- `find_agent` — natural-language discovery → ranked candidates.
- `rank_agent` — rank an explicit id set or a query, with the full 3-axis breakdown and on-chain verification.
- `get_agent_profile` — identity, capabilities, declared-vs-verified reputation, recent feedback.
- `list_services` — catalog of invokable x402 / MPP service endpoints.
- `list_agents`, `leaderboard`, `resolve_agent`, `get_agents_by_owner`, `get_agent_feedback`,
  `verify_reputation`, `get_agent_card`, `get_registry_stats`, `get_registry_health`.

**MCP resources** — `stellar8004://` scheme: `registry`, `leaderboard`, `health`, `agent/{id}`,
`agent/{id}/card`, `agent/{id}/feedback`, `agent/{id}/reputation`, `owner/{address}`. Each returns a dual
JSON + rendered-markdown payload.

**MCP prompts** — `/find-and-vet-agent`, `/vet-agent`, `/compare-agents`, `/prepare-x402-call`,
`/explore-registry`. `prepare-x402-call` stops before signing; this server holds no keys.

**On-chain reputation verification** — reputation is re-derived directly from the Reputation contract
(`get_summary` + `get_clients_paginated`) and reported as a declared-vs-verified diff
(`verified | mismatch | unavailable | skipped`). Verification runs on default mainnet with **no funded account**
by omitting `publicKey` from the Soroban read-only simulation.

**Sybil-cost-aware ranking** — three axes (quality 0.5, volume 0.2, breadth 0.3, re-normalized to sum 1) that
weight unique clients (hard to fake) above raw feedback volume (cheap to fake), plus capability bonuses for
x402 / MPP / services / verified status. This is a ranking hedge, not Sybil resistance or proof of personhood.

**Trust boundary** — server-authored prose interpolates only typed values, compile-enforced by the `serverText`
tagged template. Agent-authored free text is confined to labelled `selfDeclared` slots, sanitized (control,
zero-width, bidi, and line/paragraph separators stripped) and length-bounded.

**A2A-shaped projection** — `get_agent_card` emits a labeled, derived projection for interoperability work.
It is not fetched from an agent, does not establish endpoint/payment conformance, and is not presented as an
agent-signed or verified AgentCard.

**Human CLI** — `find`, `rank`, `profile`, `services`, `doctor`, plus the idempotent `setup` bootstrap for
Claude Code, Cursor, and Codex, with machine-readable output and live MCP handshake verification.

**Reference x402 loop** — `examples/x402-demo.ts` discovers an agent, pays its endpoint in USDC over x402, and
writes on-chain reputation feedback. The only keyed code in the repo; run manually.

**Distribution** — `server.json` (MCP Registry), `smithery.yaml`, `glama.json`, and `skills/mcp/SKILL.md` for
`npx skills add berkingurcan/stellar-agent-mcp --skill mcp`.

**Docs** — README, getting-started, architecture, full tool reference, and integration guides for 8 clients
(Claude Code, Cursor, Windsurf, Cline, VS Code, Claude Desktop, Codex CLI, Gemini CLI).

### Security

- Read-only and keyless by construction; `STELLAR_PRIVATE_KEY` is ignored if set, with a stderr warning.
- stdout carries JSON-RPC only — every log goes to stderr.
- Verification degrades closed: an unreachable RPC reports `unavailable`, never a declared figure relabelled as
  verified. An unrated agent never returns `verified`.

[Unreleased]: https://github.com/berkingurcan/stellar-agent-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/berkingurcan/stellar-agent-mcp/releases/tag/v0.1.0
