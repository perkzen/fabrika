---
name: configure
description: Read a repository's base branch, install command, checks, where its source lives and its review bot, and propose the repo-specific parts of .fabrika/config.json. Use when the host asks for a configuration at `fabrika init`.
---

# Configure

The host writes `.fabrika/config.json`; you supply the five fields that cannot
be shipped in a template because they belong to this repo: **base**, **install**,
**gate**, **source** and **provider**. Return them as structured output. Write no files —
not the config, not a scratch note.

The gate matters more than the other four. The host runs it after every stage
that changes code, and a failing step goes back to the agent as "fix it". A
step that does not exist here, or that is already red on an untouched checkout,
teaches the agent to invent a script to go green and burns the run. **An empty
gate is better than a wrong one.**

## base

The branch pull requests target, as a remote ref:

```bash
gh repo view --json defaultBranchRef -q .defaultBranchRef.name
```

Fall back to `git symbolic-ref --short refs/remotes/origin/HEAD` (only set if
someone ran `git remote set-head`), then to `main`. Prefix it with the remote:
`origin/main`. If the repo's convention is a long-lived integration branch
(`develop`, `staging`) and PRs target that, use it and say so in a note.

## install

From the lockfile, not from what the README suggests:

| Lockfile | install |
| --- | --- |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| `yarn.lock` | `yarn install --immutable` |
| `bun.lock`, `bun.lockb` | `bun install --frozen-lockfile` |
| `package-lock.json` | `npm ci` |

Another ecosystem: whatever the CI workflow's install step runs. No dependency
step at all: omit the field.

## gate

### CI is the ground truth, not `package.json`

The host opens a draft PR and then waits on that PR's checks. A gate that does
not match CI passes on the host, pushes, and spends a whole review round on a
mismatch that was readable at init. So read the workflows first.

Take workflows that trigger on `pull_request`. Within them, take the commands
that are checks. Leave out:

- checkout, toolchain setup, caching, and the install step — the host does its own
- anything needing CI context or secrets (`${{ … }}`)
- publish, deploy, release, and changelog steps
- steps whose `if:` means they do not run on a pull request
- jobs that only exist for `push`, tags, or a schedule

A step with `working-directory:` becomes `cd <dir> && <command>`. A matrix job
contributes one step with the plain command, not one per leg.

### No workflow runs on pull requests

Fall back to the repo's own scripts, in this order, including only the ones
that exist: typecheck or compile, build, test, lint, format check, knip. Use
the package manager the lockfile named (`pnpm run test`, not `npm run test`).

Outside JS: `Makefile` targets, `cargo check`/`cargo test`, `go build`/`go vet`,
whatever the repo's contributing docs tell a human to run before pushing.

### Run every candidate before you propose it

This is the step a template cannot do, and it is why you are being asked rather
than a regex. On the untouched checkout:

1. Install dependencies first if they are missing, with the install command above.
2. Run each candidate.
3. Keep the ones that pass. Drop the ones that fail, and put each dropped step
   in `notes` with its exit output, one line. Do not fix the repo to make a
   step pass — a check that is red on the base branch is the human's problem,
   not this run's.
4. Drop anything that needs something the host does not have — a database, a
   docker daemon, a browser, a live API key — and record it. It stays in CI.

Order the survivors cheapest first: compile, then test, then lint and format.
The first failure stops the gate, so the fastest signal should come first.

A step that takes more than a couple of minutes runs after every code stage.
Keep it only if it is the repo's real safety net, and note the cost.

### `when`

Only for a step that genuinely applies to part of the tree — a package in a
monorepo whose check is meaningless elsewhere. Globs match paths from the repo
root (`apps/desktop/**`). If you are guessing, leave it off.

### Never propose

`git push`, `gh pr merge`, `gh pr review`, any publish or deploy, or anything
that writes outside the worktree. The host owns those and denies them to every
stage; the answer is rejected outright if one appears in a gate step.

## source

Globs naming where this repo's own source lives. The host puts them on the
`refactor` stage, which then runs only when the branch changed a file matching
one — an architecture pass is worth paying for when there is architecture in
the diff, and not when the ticket merely said `feat`.

Read the tree and name what is there: `src/**`, `lib/**`, `apps/*/src/**`,
`packages/*/src/**`. Several are fine when the code is genuinely in several
places.

Leave out tests, docs, fixtures, generated output and lockfiles. A branch that
only touches those has nothing to reshape, which is exactly the case this field
exists to skip.

Globs match paths from the repo root, and `src/**` matches every file beneath
`src` at any depth. Record what you chose and why in `notes` — it is the one
judgement in the file a human will want to check.

If nothing usable comes back the host writes `src/**` rather than rejecting the
answer, so a repo whose layout you cannot read costs the field and not the gate.

## provider

Which review bot this repo has. The run waits for it after it opens the draft
PR, so a provider the repo does not have is a run that escalates on a review
that was never coming.

Read it off the repo's own pull requests, which is the same signal the run
itself matches on later:

```bash
gh api "repos/{owner}/{repo}/pulls?state=all&per_page=20" -q '.[].number'
gh api "repos/{owner}/{repo}/pulls/<number>/reviews" -q '.[].user.login'
```

A review by `cubic-dev-ai[bot]` on any recent pull request means `cubic`.
Anything else — no such review, no pull requests at all, or an endpoint you
cannot read — means `none`.

**Not `gh api graphql`.** This call runs under the same `deny` list as every
stage, which forbids it; the REST endpoints above are what is available here.

`none` is not a degraded mode. The run keeps the half of the review loop that
does not need a bot: it waits for the checks, hands a failing check's log back
to the agent, reruns a suspected flake once, and escalates after
`review.maxRounds` exactly as it would with one. Only the threads and the score
go away. So say which one you chose and what you saw in `notes` — a human
correcting `none` to `cubic` is a one-word edit.

## notes

One line per gate step saying where it came from and that it passed, plus every
judgement a human should check: a dropped step and why, a base branch that was
not obvious, a check that CI runs but the host cannot, and the review bot you
found or did not find, with what you looked at. This is the only place
the reasoning survives — the config itself is just JSON.
