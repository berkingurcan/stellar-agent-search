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

### Changed

- The skill now ships from this repository at `skills/mcp/SKILL.md` (was `skill/SKILL.md`, destined for
  `trionlabs/stellar-8004`). Install with `npx skills add berkingurcan/stellar-agent-mcp --skill mcp`.
  Rationale: [docs/evidence.md §3](docs/evidence.md).
- The skill's `mcp-package-version` pin is `>=0.1.0`, not `^0.1.0`. A caret range on a 0.x package resolves to
  `>=0.1.0 <0.2.0`, so the pin would have excluded the next minor release.
- README and the getting-started guide now show one registration command instead of two at differing scopes, and
  the getting-started guide documents the skill install it had been missing.

### Fixed

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
  tarball (it does not — `files` excludes `skills/`, deliberately), that the one-command install was already
  verifiable (it needs the repo public and `main` as the default branch), and the automated test count.

## [0.1.0] — unreleased

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

**Sybil-resistant ranking** — three axes (quality 0.5, volume 0.2, breadth 0.3, re-normalized to sum 1) that
weight unique clients (hard to fake) above raw feedback volume (cheap to fake), plus capability bonuses for
x402 / MPP / services / verified status.

**Trust boundary** — server-authored prose interpolates only typed values, compile-enforced by the `serverText`
tagged template. Agent-authored free text is confined to labelled `selfDeclared` slots, sanitized (control,
zero-width, bidi, and line/paragraph separators stripped) and length-bounded.

**A2A interop** — `get_agent_card` projects an agent into an A2A AgentCard v0.3 carrying the canonical
a2a-x402 extension URI.

**Human CLI** — `find`, `rank`, `profile`, `services`, `doctor`, with `--json` and `--log-level`.

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
