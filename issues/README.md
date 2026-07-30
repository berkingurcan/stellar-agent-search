# Open issues

Remaining work, one file per issue, tracked in-repo so the state of the project is legible from a clone
alone — no access to a tracker required. Once the repository is public, GitHub Issues is the better home for
*discussion*; these files stay the source of truth for *what is outstanding* and each can be filed verbatim.

**Priority**

| | Meaning |
|---|---|
| **P0** | Blocks delivery of the SOW |
| **P1** | A real defect that reaches users of the published package |
| **P2** | An unverified claim, or a precondition nobody has checked |
| **P3** | Deliberately out of SOW scope — candidate for the follow-on proposal |

**Owner** — *Builder* needs funds, credentials, or a GitHub setting only the owner can change. *Code* is a
change in this repository.

**Mandatory first-release order:** private move to selected owner `berkingurcan` → inert `0.0.0` reservation under
the non-default `bootstrap` tag while private → public repository → protected OIDC real release.

| # | P | Title | Owner |
|---|---|---|---|
| [01](P0-01-make-repository-public.md) | P0 | ~~Move to selected owner `berkingurcan`; make public only after 03 phase A~~ **resolved** | Builder + current repo owner + Berkin |
| [02](P0-02-set-default-branch-to-main.md) | P0 | ~~Set the default branch to `main`, delete the working branch~~ **resolved** | Builder |
| [03](P0-03-first-npm-publish.md) | P0 | ~~Inert private bootstrap, then protected OIDC real publish~~ **npm resolved**; MCP Registry awaits the failed-job re-run | Builder |
| [04](P0-04-funded-mainnet-x402-run.md) | P0 | Funded mainnet x402 run → two transaction hashes — **ready: payer funded, challenge validates under the reviewed policy** | Builder |
| [05](P0-05-record-three-demos.md) | P0 | Record the three demo videos | Builder |
| [06](P1-06-published-package-ships-vulnerable-axios.md) | P1 | Published package ships a vulnerable, proxy-broken axios | Code |
| [07](P1-07-testnet-mode-has-no-explorer.md) | P1 | ~~`STELLAR_NETWORK=testnet` has no explorer and cannot work~~ **resolved** | Code |
| [08](P2-08-verify-scrapper-endpoint-is-live.md) | P2 | Fix and re-verify the target's HTTPS x402 challenge before spending | Upstream Scrapper deploy owner |
| [09](P2-09-substantiate-only-non-evm-claim.md) | P2 | ~~Substantiate or soften the "only live non-EVM" claim~~ **resolved** | Code |
| [10](P3-10-validation-registry-axis.md) | P3 | Validation registry as a fourth trust axis | Code |
| [11](P3-11-remote-stateless-deployment.md) | P3 | Remote / stateless deployment — **implemented; production canary blocked** | Code + Builder |
| [12](P3-12-stellar-native-paid-tools.md) | P3 | Stellar-native paid MCP tools | Blocked upstream |
| [13](P3-13-upstream-discovery-api-v2.md) | P3 | Upstream cursor-based discovery API v2 | Blocked upstream |
| [14](P3-14-upstream-reputation-aggregate-v2.md) | P3 | Upstream scalable reputation aggregate v2 | Blocked upstream |
| [15](P1-15-upstream-stats-must-fail-closed.md) | P1 | Upstream `/stats` must fail closed on Supabase errors | Blocked upstream |
| [16](P1-16-upstream-v1-list-count-amplification.md) | P1 | Upstream v1 list count query materializes the registry | Blocked upstream |
| [17](P2-17-align-official-sdk-mcp-navigation.md) | P2 | Align official SDK/MCP docs, navigation, and compatibility contract | Trion Labs + Code |
| [18](P1-18-upstream-registry-contract-attestation.md) | P1 | Attest the exact upstream registry contracts, not only `mainnet` | Blocked upstream |
| [19](P1-19-upstream-api-reads-must-fail-closed.md) | P1 | Fail closed on every remaining Supabase API read error | Blocked upstream |
| [20](P1-20-upstream-rate-limiter-must-fail-closed.md) | P1 | Stop allowing requests when the upstream limiter RPC fails | Blocked upstream |
| [21](P1-21-upstream-indexer-integrity-watermark.md) | P1 | Expose durable checkpoint/dead-letter integrity state | Blocked upstream |
| [22](P1-22-upstream-leaderboard-freshness.md) | P1 | Bind leaderboard freshness to its last successful projection refresh | Blocked upstream |

## A note on review

This repository has had **no external code review**. It is the work of a single contributor, checked by an
automated suite and several adversarial self-review passes — which is not the same thing as another engineer
reading it. The invariants in [CONTRIBUTING.md](../CONTRIBUTING.md) describe what the tests actually enforce;
treat anything outside that as unreviewed. Issues and PRs are welcome.
