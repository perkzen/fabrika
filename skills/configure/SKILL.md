---
name: configure
description: Read a repository's base branch, install command and checks, and propose the repo-specific parts of .fabrika/config.json. Use when the host asks for a configuration at `fabrika init`.
---

# Configure

The host writes `.fabrika/config.json`; you supply the three fields that cannot
be shipped in a template because they belong to this repo: **base**, **install**
and **gate**. Return them as structured output. Write no files — not the config,
not a scratch note.

The gate matters more than the other two. The host runs it after every stage
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

## notes

One line per gate step saying where it came from and that it passed, plus every
judgement a human should check: a dropped step and why, a base branch that was
not obvious, a check that CI runs but the host cannot. This is the only place
the reasoning survives — the config itself is just JSON.
