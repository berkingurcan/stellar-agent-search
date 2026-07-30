# P1-06 — Published package ships a vulnerable, proxy-broken axios

**Owner:** Code · **Status:** fixed locally; packed-consumer proof green, publication gate still pending

## Original problem

`@trionlabs/stellar8004@0.0.11` depends on Stellar SDK v15, whose exact
`axios@1.15.0` branch carried high-severity advisories and failed through some HTTPS proxies. Root npm
`overrides` do not propagate into a downstream consumer, so the earlier workspace-only override was not a
release fix.

## Implemented fix

- Exact-pin `@stellar/stellar-sdk@16.2.0` as the single runtime Stellar SDK.
- Keep exact `@trionlabs/stellar8004@0.0.11` as a development/build dependency and vendor its canonical
  Explorer/config/generated-binding code with tsup `noExternal`.
- Keep x402 packages and dotenv development-only because only the unshipped reference example imports them.
- Force the development graph's upstream SDK and x402 SDK onto the same root v16 instance.
- Build the contract reader from Stellar SDK v16's fetch-based default `/contract` export.
- Ship `THIRD_PARTY_NOTICES.md` with the embedded SDK's MIT notice.
- Reject axios implementation markers in the Worker dry-run bundle.

This preserves the upstream generated contract `Spec` and Explorer behavior rather than hand-copying the
ABI, while preventing the upstream package's v15 dependency from reaching npm consumers.

## Proof — 2026-07-29

A freshly built `stellar-agent-search-0.1.0.tgz` was installed into an empty project with scripts disabled:

- tarball: 6 files, including `THIRD_PARTY_NOTICES.md`; no runtime `@trionlabs` dependency;
- shipped JavaScript contains the upstream Explorer client and Reputation
  `get_clients_paginated` read ABI, with no runtime `@trionlabs` import;
- clean consumer: exactly one `@stellar/stellar-sdk@16.2.0`;
- clean consumer: no `@trionlabs/stellar8004` or x402 install;
- CLI `--version`: `0.1.0`;
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.

Stellar SDK v16.2.0 still declares `axios@1.18.0` in its package dependencies, so it appears in the clean
consumer's `node_modules`. The shipped MCP/read path does not import axios implementation code, and the
installed version is not vulnerable according to the audit above. The precise guarantee is therefore **no
vulnerable v15/axios branch and no axios code on the read path**, not “axios is absent from disk.”

## Remaining external work

Upstream [trionlabs/stellar-8004#17](https://github.com/trionlabs/stellar-8004/pull/17) should still add and
pass explicit v16 compatibility coverage before Trion Labs widens and republishes its supported peer range.
That would let a future release stop vendoring. It is no longer required to keep this package's downstream
consumer off the vulnerable v15 branch.

## Acceptance

- [x] Contract reads use the fetch transport.
- [x] Packed consumers resolve one Stellar SDK major.
- [x] Packed consumers do not install the upstream SDK package or x402 demo dependencies.
- [x] Packed-consumer production audit has no high/critical finding.
- [x] Vendored MIT code is attributed in the tarball.
- [ ] Repeat the same proof against the immutable npm artifact after the protected OIDC publish.
