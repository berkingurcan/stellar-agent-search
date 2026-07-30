# P1-07 — `STELLAR_NETWORK=testnet` has no explorer and cannot work

**Owner:** Code · **Status:** resolved — testnet now refuses to start without an explicit explorer

## Problem

`STELLAR_NETWORK` selects the Soroban contracts and the RPC endpoint, but the explorer base URL is
network-independent (`DEFAULT_EXPLORER_BASE = "https://stellar8004.com"`), and that explorer indexes **mainnet
only** — its own responses report `"network": "mainnet"`.

So `STELLAR_NETWORK=testnet` returned **mainnet registry rows** alongside **testnet on-chain reads**: two chains
described as one. Nothing said so until a warning was added, and a warning still left the mixed result in place.

## Impact

- `find_agent`, `list_services`, `list_agents` returned mainnet agents while claiming testnet.
- `verify_reputation` queried testnet contracts for mainnet agent ids, so verification reported `unavailable` or
  `mismatch` for reasons that had nothing to do with the agent.
- `docs/recordings.md` documented `STELLAR_NETWORK=testnet DRY_RUN=1` as the rehearsal step, so a builder
  following the instructions walked straight into it.

It violated the project's own fourth invariant — *degrade closed, never fake* — by presenting agreement that
does not exist.

## Fix

`loadConfig` now **throws** when `STELLAR_NETWORK=testnet` is not accompanied by an explicit
`EXPLORER_BASE_URL`. That is the first of the two honest options the earlier draft of this issue listed; the
other — ship a testnet indexer — is upstream and out of our control. A warning was rejected on a second pass:
it names the problem but still serves the mixed answer, which is the behaviour the invariant forbids.

Three details worth knowing:

- **Blank counts as absent.** `EXPLORER_BASE_URL=""` or all-whitespace refuses too, so an empty value in a
  `.env` cannot re-open the seam.
- **It fails as a misconfiguration, not a crash.** The throw is a `ConfigError` (`src/config.ts`), and the
  entry point prints it as a plain `error:` line and exits **2** — the same shape `parseFlags` already used for
  a bad flag — instead of the `fatal:` stack trace every other unhandled error gets. `STELLAR_NETWORK` parsing
  moved to the same class for the same reason. Verified against `doctor`, `find --network testnet`, and the
  non-TTY `serve` launch every MCP client uses.
- **The rehearsal command changed.** `STELLAR_NETWORK=testnet DRY_RUN=1` was the documented gate before the
  funded run and now fails at startup by design. It is replaced by `DRY_RUN=1` on mainnet in
  `docs/recordings.md` and `examples/README.md`. Nothing is lost — `DRY_RUN=1` spends nothing, and unlike the
  testnet variant it exercises the exact path the funded run takes. `README.md`, `docs/getting-started.md`,
  `.env.example`, `examples/.env.example`, `server.json`, `smithery.yaml` and `skills/mcp/SKILL.md` all say
  `testnet` requires the explorer.

The x402 demo was never at risk: it compares the 402 challenge's network against the configured CAIP-2 id and
aborts with `network mismatch`.

Pinned by `test/fixes.test.ts` — the refusal, the blank-value case, and the two combinations that must still
start (mainnet, and testnet with an explicit explorer).

## Acceptance

- [x] Either testnet mode returns testnet data, or it refuses to run without an explicit explorer. — refuses.
