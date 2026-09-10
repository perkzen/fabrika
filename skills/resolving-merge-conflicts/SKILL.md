---
name: resolving-merge-conflicts
description: Resolve an in-progress git merge or rebase conflict and finish it, never abort. Use when the host reports conflicts after merging the base branch into this one.
---

# Resolve conflicts

1. **See the state.** `git status`, `git log --oneline --left-right HEAD...MERGE_HEAD`, and each conflicting file with its markers.

2. **Find the primary sources** for each conflict. This branch's intent is in `.fabrika/work/spec.md` and the Decisions in `.fabrika/work/plan.md`; the other side's is in its commit messages and any PR or ticket they name. Understand why each change was made before touching a hunk.

3. **Resolve each hunk.** Preserve both intents where possible. Where they are incompatible, keep the base's behaviour for code this ticket did not set out to change, and this branch's behaviour for what the spec asks; record the trade-off in the merge commit message. Invent no new behaviour. Always resolve; never abort.

4. **Run the project's checks** — typecheck, the tests touching the conflicted files, then format — and fix what the merge broke. A behaviour fix goes through `fabrika:tdd`.

5. **Finish the merge.** Stage everything and commit; for a rebase, continue until every commit is replayed.

Done when `git diff --name-only --diff-filter=U` prints nothing and no merge or rebase is in progress.
