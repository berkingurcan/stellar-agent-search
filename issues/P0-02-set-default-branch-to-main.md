# P0-02 — Set the default branch to `main`, delete the working branch

**Owner:** Builder · **Blocks:** repository hygiene · **Status:** partially resolved

## Problem

The repository's default branch was `claude/stellar-agent-search-discovery-9jbp5g` — a disposable working branch —
not `main`. The two branches were identical (`origin/main == origin/claude/…`, zero commits apart), so nothing
was lost by switching.

## Impact

Three separate consequences, all invisible until they bite:

1. **`npx skills add` reads the default branch.** It worked only because both branches pointed at the same
   commit. Deleting the working branch — normal cleanup — would silently repoint HEAD and break the documented
   one-command install for everyone.
2. **CI never runs on the branch GitHub shows by default.** `.github/workflows/ci.yml` triggers on
   `push`/`pull_request` to `main` only, while `docs/evidence.md` sends reviewers to the Actions tab, which is
   scoped to the default branch.
3. **The branch name will become visible if the repository is made public** and contains a tool name that has
   nothing to do with the project.

## Current state — 2026-07-29

1. Default branch set to `main` (by hand, in Settings).
2. The old working branch still exists and remains to be deleted:
   ```bash
   git push origin --delete claude/stellar-agent-search-discovery-9jbp5g
   git remote prune origin
   ```

Verified with the GitHub API: the default branch is `main`, but both `main` and
`claude/stellar-agent-search-discovery-9jbp5g` still exist at the same SHA (`f950a14`). Deleting the stale branch
is safe, but it has not happened yet.

3. The second copy of the same branch name in `trionlabs/stellar-8004` was deleted too.

   Unlike the copy here it was **not** identical to its `main`: 1 commit ahead, `0f62818` —
   `feat(skills): add mcp skill for runtime agent discovery`, adding `skills/mcp/SKILL.md` and 8 README lines.
   That skill now lives in *this* repository at `skills/mcp/SKILL.md` and is maintained here (pinned against
   drift by `test/skill-sync.test.ts`), so the branch carried a stale duplicate, not unique work. Checked
   before deleting: no PR in that repository, open or closed, referenced the branch. The SHA is recorded above
   should anyone ever want it back.

## Why the first attempt was a hand task and not a scripted one

Both steps were attempted from a sandboxed automated environment and both were refused at the network layer,
not by GitHub permissions. Recorded so nobody burns time retrying **in that environment** — from a normal
shell with `gh` authenticated, both work:

```
PATCH /repos/berkingurcan/stellar-agent-search  {"default_branch":"main"}
  → 403  "Repository settings writes are not permitted through this proxy."

git push origin --delete claude/stellar-agent-search-discovery-9jbp5g
  → send-pack: unexpected disconnect while reading sideband packet

DELETE /repos/trionlabs/stellar-8004/git/refs/heads/claude/…
  → 403  "Write access to this GitHub API path is not permitted through this proxy."
```

## Acceptance

- [x] The source repository reports `"default_branch": "main"`; verify the same after transfer to `berkingurcan/stellar-agent-search`.
- [ ] The GitHub branches API lists `main` and no stale working branch.
- [x] The duplicate branch in `trionlabs/stellar-8004` is deleted.
- [ ] A push to `main` produces a CI run visible on the default Actions view — confirm on the next push.
