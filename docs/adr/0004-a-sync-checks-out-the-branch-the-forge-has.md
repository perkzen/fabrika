---
status: accepted
---

# A sync checks out the branch the forge has

A sweep's worker starts by fetching and **hard-resetting** its worktree to
`<remote>/<branch>`, through a new `Workspace.checkout` that is a second
operation beside `create` rather than a flag on it. A pull request's branch is
whatever the forge has: the local branch that survived `git worktree remove`
after a run finished can hold an escalated run's tip or a history someone
rewrote, and a merge computed against that resolves conflicts nobody else has
and pushes the result over a colleague's commit.

## Considered Options

- **`git merge --ff-only <remote>/<branch>`.** Rejected: it turns the case
  this ticket most cares about — a local tip the remote does not have — into a
  failure rather than doing the right thing, and a sweep that escalates on
  leftover local state is a sweep that stops working the moment a run
  escalates.
- **Reusing `create`, or adding a `reset` flag to it.** Rejected: `create` is
  the path a *run* resumes through, where unpushed commits are the run's own
  work and losing them is the failure. One function that destroys commits
  under one flag and preserves them under another is one flag away from
  losing a run.

## Consequences

The hard reset is fenced by the selection rule that skips any PR whose branch
is checked out anywhere on this machine — so it only ever runs against
fabrika's own sweep worktree, never the operator's checkout and never a live
run's tree. That rule and this reset are load-bearing for each other: dropping
the check would make the reset unsafe.

That rule reads `git worktree list` once, before the fan-out, so it fences one
sweep and not two. `checkout` therefore resets only a tree it has just
created: a directory already at the worktree path is one that appeared after
the listing, which is another `fabrika sync` mid-merge in it, and the second
sweep refuses that pull request rather than resetting over the first's work.
