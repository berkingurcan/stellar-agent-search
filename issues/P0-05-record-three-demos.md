# P0-05 — Record the three demo videos

**Owner:** Builder · **Status:** partially complete — Recording 2 captured but not uploaded; Recordings 1 and 3 outstanding

## Problem

The SOW requires a screen recording per deliverable. The funded mainnet run was captured, but no durable video
link has been added to the repository. The tool walkthrough and clean-environment install recordings remain
outstanding. Shot-by-shot scripts are in [docs/recordings.md](../docs/recordings.md).

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

Three durable links pasted into `docs/evidence.md` §1–§3, replacing the placeholders, with status markers
changed to ✅ only after each link is reviewable.
