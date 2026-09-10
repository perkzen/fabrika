---
name: fix-ci
description: Fix a failing pull-request check from its log. Use when the host reports checks that failed after a push.
---

# Fix CI

The host watched the PR's checks and hands you the ones that failed, each with the log of its failed steps. It has already rerun every failed run once, so these are not flakes.

1. **Find the first real error** in each log: the earliest line that names a file, test, or command that failed. What follows is usually cascade. Two checks failing on the same cause are one fix.
2. **Reproduce locally** where you can: the gate step in `.fabrika/config.json` whose command matches the check, or the command the workflow runs (`.github/workflows/`). A failure that reproduces locally is fixed test-first through `fabrika:tdd`. One that only reproduces in CI — environment, version, secret-gated tests — is fixed from the log and the workflow's definition.
3. **One cause per commit**, message `fix(ci): <cause>`.
4. **The check stays as it is.** Skipping, disabling, loosening, or marking a check as expected-to-fail is never the fix. A workflow file changes only to fix a bug in the workflow itself, said so in the commit.
5. **Unrelated failures** — the same failure on the base branch — are recorded, not fixed; the host merges the base every round.
6. **Gate gaps.** When CI caught something no local gate step could, add it under `## Gate gaps` in `.fabrika/work/pr.md` (create the section): which check, and the command that would catch it locally. The human decides whether the gate grows.

Record every failed check in `.fabrika/work/ci.md`: check, cause, and `fixed (<commit>)`, `unrelated: <evidence>`, or `not reproducible: <what was tried>`.

Done when every failed check has its line in `ci.md`, typecheck and the affected tests are green locally, and everything is committed.
