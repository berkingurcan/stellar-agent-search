# P0-05 — Record the three demo videos

**Owner:** Builder · **Blocked by:** [01](P0-01-make-repository-public.md), [02](P0-02-set-default-branch-to-main.md), [03](P0-03-first-npm-publish.md), [04](P0-04-funded-mainnet-x402-run.md) · **Status:** open

## Problem

The SOW requires a screen recording per deliverable. None exist. Shot-by-shot scripts are written in
[docs/recordings.md](../docs/recordings.md); this issue only tracks that they have not been shot.

## Order matters

Recording 3 is filmed on a **fresh machine with no credentials**, and its first on-camera command is
`npx skills add …`, which fetches from GitHub's default branch. Recording 1 and 3 both then run
`npx -y stellar-agent-search`. So 01, 02 and 03 must all be done first or the take fails on camera — and
`docs/recordings.md` forbids editing mid-take.

Verify both preconditions from a logged-out shell before hitting record:

```bash
npm view stellar-agent-search version
curl -sI https://raw.githubusercontent.com/berkingurcan/stellar-agent-search/main/skills/mcp/SKILL.md | head -1
```

## Acceptance

Three unlisted links pasted into `docs/evidence.md` §1–§3, replacing the `‹…›` placeholders, and the status
markers flipped from ⬜ to ✅.
