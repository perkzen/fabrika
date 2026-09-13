---
id: cloud-run
type: feat
---
# Make a run finish on a cloud runner that is root and refuses GraphQL

fabrika is written for the machine it was born on: a macOS terminal, a
logged-in `claude`, a `gh` that may speak GraphQL, and a uid that is not zero.
A Claude Code cloud session — the environment this ticket was written in —
breaks three of those four, and it breaks them early: no stage does any work at
all, because the flag every agent call carries is refused before the first
prompt is read.

Four places are recorded below. The first stops a run dead; the second stops a
pull request after six stages of work; the third is the reviewer, which is
GraphQL by construction and portable only against routes that exist in this
environment alone; the fourth is the preflight that should have said all of it
before the run spent an install.

Everything here was measured in a session on 2026-09-13 rather than reasoned
from structure. Where a claim is a check that was actually run, it says so.

## Constraints

- **The deny list is the permission model.** `src/infra/claude.ts:109` is
  explicit: under `-p` a gated tool call is denied, not asked, and
  `--dangerously-skip-permissions` is only tolerable because `config.deny`
  bounds it. Dropping the flag does not make a run safer — it makes every stage
  die on a question nobody can answer. Whatever replaces it keeps the deny list
  load-bearing.
- **The host holds no secret.** `src/cli.ts` documents this for Linear and it
  holds here: fabrika registers no credential and loads no `.env`. A cloud
  runner injects a placeholder `GH_TOKEN` for its proxy to substitute, so
  fabrika must keep reading the environment rather than learning to store a
  token.
- **A cloud runner is ephemeral.** The container is reclaimed on inactivity, so
  anything a run has not pushed is gone. That is the argument for making the
  pull request work rather than treating it as the optional last step.
- **The `ccr/*` routes are not GitHub's.** The paths in finding 3 are served by
  this environment's proxy, not by api.github.com. Code that depends on them
  works here and nowhere else, which is why finding 3 stays behind
  `review.provider`.

## Findings

### 1. Every agent call is refused before it runs, because the runner is root

`src/infra/claude.ts:111` passes `--dangerously-skip-permissions` on every
`claude -p`. A cloud session runs as uid 0, and Claude Code refuses that flag as
root: `--dangerously-skip-permissions cannot be used with root/sudo privileges
for security reasons`. Nothing in the pipeline survives it. `spec`, `plan`,
`implement`, `refactor`, `security` and `review` each fail with `AgentFailed`
before reading a prompt, and `fabrika init` goes the same way — `src/configure.ts:171`
is the same `runClaude`, so `proposeConfig` cannot propose either.

This is already visible in the repo's own gate rather than only in a real run:
`pnpm test` fails 2 of 354 on an untouched checkout here, and both
(`test/cli.test.ts:97` and `test/cli.test.ts:110`) fail with exactly that
message, because both drive the real binary to assert that `--steps` reaches the
auth probe. They pass on a non-root machine. So a cloud run's first honest
symptom is a red gate on code nobody wrote — which is the thing `fabrika init`
warns about, and the thing a gated stage handles worst: it would hand the agent
"fix it" up to `maxIterations` times.

Three ways out, not mutually exclusive:

- Pass `IS_SANDBOX=1` through to the child when the operator has opted in, which
  is Claude Code's own escape hatch for this. Recorded with its caveat: in the
  session this ticket was written in, that spawn was then refused again by the
  host's auto-mode classifier, so the variable is necessary and not always
  sufficient. It cannot be the only answer.
- Drop privileges for the child when the run is root and a non-root user exists.
  The worktree is the host's, so ownership has to move with it.
- Failing both, refuse in `preflight` with one sentence naming uid 0, rather than
  six stages failing identically (finding 4).

Whichever is taken, the deny list stays the bound, per the constraint above.

### 2. The pull request is GraphQL, and this environment answers 403

`src/adapters/gh-forge.ts` reaches GitHub through `gh` subcommands that route via
GraphQL, and the proxy refuses GraphQL outright with `HTTP 403: GitHub GraphQL is
not available from Claude Code sessions`:

- `:152` — `createArgs`, i.e. `gh pr create`. Checked: 403.
- `:239` — `gh pr list --json`, which is how a run finds a PR it already opened.
  Checked: 403.
- `:266` — `gh pr view --json headRefOid,statusCheckRollup`, which is the whole
  of how the review loop waits for checks.
- `:302` and `:306` — `gh pr view --json body` and `gh pr edit --body-file`.

A run that got past finding 1 would therefore do six stages of work and lose all
of it at the last step, on a disk that does not survive the session.

REST covers what is needed, and the replacements were checked in the same session
against `origin/main`:

- `gh api repos/{owner}/{repo}/pulls` — lists, and creates with `-X POST` and a
  `draft` field, which is what `pr.draft` already asks for.
- `gh api repos/{owner}/{repo}/commits/{sha}/status` — returned `pending`.
- `gh api repos/{owner}/{repo}/commits/{sha}/check-runs` — returned a count.

The rollup `:266` wants is those last two read together, which is what
`statusCheckRollup` is. Worth recording that the boundary is already half-drawn
from the other side: `src/config.ts:64` and `:167` deny `gh api graphql` to the
*agent*, on the grounds that a stage has no business there. It is the host's own
adapter that turns out to need it.

### 3. The cubic reviewer cannot be ported, only redirected

`src/adapters/cubic-reviewer.ts` writes GraphQL by hand — the thread query at
`:86`, the mutation helper at `:123`, `addPullRequestReviewThreadReply` at `:154`,
`resolveReviewThread` at `:159`. Review threads and thread resolution have no
equivalent in GitHub's public REST API, so unlike finding 2 this is not a rewrite
against documented endpoints.

This environment does publish routes for exactly these, named in the 403 body:
`GET /repos/{owner}/{repo}/pulls/{n}/ccr/review_threads` and
`POST /repos/{owner}/{repo}/pulls/{n}/ccr/comments/{comment_id}/resolve`. They are
the proxy's, not GitHub's, per the constraints — so a cubic reviewer built on them
runs here only.

That makes this the one finding where the right move may be to leave the adapter
alone. This repo's own `.fabrika/config.json` says `review.provider: "none"`,
`CONFIG_TEMPLATE` ships `none`, and `noReviewer.await` (`src/adapters/no-reviewer.ts`)
returns a synthetic review without waiting — so a cloud run with `none` never
reaches this code at all. Out of scope below rather than ported.

### 4. Preflight checks the config and not the machine

`src/pipeline/steps/preflight.ts` fails on a missing prompt file and on an MCP
server a stage names, and its docstring says why: "before the run spends an
install and two stages getting there". That is the right instinct aimed at the
wrong half of the problem. It does not check that `claude` is on `PATH`, that
`gh` is on `PATH`, or that an agent can be spawned at all.

`gh` was not installed in this image; it had to be fetched by hand before
anything in finding 2 could be tested. A run here would reach the pull request
after six stages and only then discover it has no forge.

Findings 1 and 2 each become one sentence at preflight instead of a wasted run,
and neither needs the pipeline to change to get it.

## Not findings

Three things that look like they break here and do not:

- **`keepAwake`.** `src/run.ts:159` already warns `keepAwake is macOS-only —
  ignored here` and carries on; `src/infra/keep-awake.ts` is only reached on
  darwin. Correct as written.
- **Node 22 against `engines: ">=24"`.** pnpm warns and nothing else happens:
  `pnpm install --frozen-lockfile`, `pnpm compile` and `pnpm build` all pass, and
  `node src/cli.ts --help` runs. The two test failures are finding 1, not the
  engine.
- **`GH_TOKEN` reading as invalid.** `gh auth status` calls the token invalid
  because the value is a placeholder the proxy substitutes in flight; `gh api
  user` returns the real account. Anything that probes auth by validating the
  token locally will be wrong here, so finding 4 must not add such a probe.

## Scope

In: findings 1, 2 and 4. Out: finding 3, recorded above and left to whoever runs
a cloud fabrika against a repo that has the cubic bot.

Finding 1 changes how the agent child is spawned, and may add one config field or
one environment passthrough. Finding 2 rewrites `gh-forge` internals against REST
and moves no port: `Forge` keeps its shape, and the review loop above it cannot
tell the difference. Finding 4 adds checks to a step that already exists.

## Done when

- A run whose uid is 0 either completes its stages or is refused at preflight with
  one sentence naming why; it never fails six stages with the same message.
- `pnpm test` passes on a root cloud runner, or the two `test/cli.test.ts` cases
  state the environment they need and skip rather than fail.
- `gh-forge` opens a draft pull request, finds one it already opened, reads and
  edits a body, and reports a check rollup, with no GraphQL call on any path.
- Preflight names a missing `claude`, a missing `gh`, and an agent it cannot
  spawn, before the install.
- `pnpm rehearse` still reads correctly, and a `provider: "none"` run needs no
  `ccr/*` route.

## Assumptions

Recorded rather than asked, per the unattended rule; a human corrects them here
before the run.

- Cloud support belongs in-tree rather than in a fork. The alternative is that
  fabrika is a laptop tool, which contradicts `sync` already being written to be
  scheduled.
- Nobody wants an `--allow-root` flag that only silences the check. Root is the
  runner's fact, not the operator's preference, so it is detected rather than
  declared.
- The REST rewrite keeps `gh` as the transport rather than moving to `fetch`:
  `gh` is what resolves the token, and the constraint above says fabrika holds no
  secret of its own.
- `statusCheckRollup`'s shape can be reproduced from `status` plus `check-runs`
  closely enough that the review loop's failing/flaky split is unchanged. If it
  cannot, that is a finding of its own and not a licence to widen this one.
