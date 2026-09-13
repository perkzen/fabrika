---
id: parallel-run
type: feat
---
# Do the parts of a run that do not depend on each other at the same time

A run is serial from end to end. The only concurrency fabrika has today is the
sweep's bounded fan-out over sync workers (`src/pipeline/sweep.ts`), and nothing
inside a single run borrows it — not the two waits a review round sits through,
not the gate the stages run up to sixteen times, not the two halves of a
capture, and not the agent itself, which fans out in exactly one skill.

Seven places are recorded below, ordered by wall clock won over risk for a repo
whose `review.provider` is `cubic`. On a repo configured `none` — which is what
fabrika's own `.fabrika/config.json` says — finding 1 wins nothing and finding 3
is the top of the list; see finding 1 for why. The first five are this ticket. The last two are written down because they are real and
because the next person to read this should not have to find them again; they
are redesigns, and scoping them here would make this ticket a rewrite.

## Constraints

These decide what may and may not run at the same time, and every finding below
is placed against them.

- **One worktree, one writer.** `src/pipeline/step.ts` states the contract:
  what travels between steps is the worktree, the artifacts in it and the run's
  state, all of it durable. Two agents mutating one worktree is a git race, so
  anything parallel inside a run is either read-only or works in a tree of its
  own.
- **One login, one budget.** Every `claude -p` call draws on the same
  rate-limit window. `AgentRateLimited` already exists, and the sweep already
  has the pattern for it: `src/pipeline/sweep.ts` stops handing out new work
  once a worker hits the limit rather than cancelling what is in flight.
- **Nothing here is profiled.** No real ticket has been through the six-stage
  pipeline yet, so the ordering below is reasoned from structure, not measured.
  The archive's step summaries carry per-step durations; one real run should
  re-rank this list before the harder findings are picked up.

## Findings

### 1. A review round waits for the reviewer and for the checks one after the other

`src/pipeline/steps/review.ts:73` waits up to `review.timeoutMinutes` for the
reviewer's verdict. `src/pipeline/steps/review.ts:78` then waits up to
`checks.timeoutMinutes` for the checks on the same pushed commit. The two
signals are independent — neither wait's subject can be affected by the other —
but the worst cases are additive, and a run gets `review.maxRounds` of them: on
the shipped config, up to 165 minutes of waiting where 90 would do.

This is worth nothing to a repo with no review bot. `noReviewer.await`
(`src/adapters/no-reviewer.ts`) returns a synthetic review immediately rather
than waiting, so a `provider: "none"` round sits through one wait, not two — and
`CONFIG_TEMPLATE` ships `none`, as does this repo's own config. The finding is
real, and it is the largest of the seven, but only under `provider: "cubic"`.

Run them together. One catch has to be answered first: the outline holds a
single open wait (`src/domain/outline.ts:81`) and a `wait end` clears it
whichever wait ended, so two concurrent `waitFor`s would blank the liveness line
while one of them is still open. Either both go under one `waitFor` whose
subject names the pair, or the outline learns to hold more than one wait.

### 2. Four serial forge loops in a review round

Every one of these is a `gh` round trip in a `for`, and none of the iterations
can observe each other:

- `src/pipeline/steps/review.ts:138` — one `forge.failureLog` per failing check.
- `src/pipeline/steps/review.ts:83` — one `forge.rerun` per flaky check.
- `src/pipeline/steps/review.ts:174` — `reviewer.reply`, and `reviewer.resolve`
  at `:179`, one per decision.

Bounded `Effect.forEach`. Minutes rather than hours, and no contract moves.

### 3. The gate runs its steps one at a time

`src/adapters/shell-gate.ts` is deliberate about it: sequential, deterministic,
first failure wins. It is also the most-repeated thing in a run — four gated
stages times `maxIterations`, so up to sixteen full gate runs for one ticket.

Running independent steps together is the largest win in the stage loop, and it
moves two contracts. The agent is handed one failure today and would be handed
all of them, which is a different prompt and arguably a better one. And a repo
whose `build` must precede its `test` breaks outright. So this is per-repo
opt-in in the committed gate config — a `needs` or a `parallel` on the step —
and never a global flag: the gate for a repo belongs in that repo.

### 4. A capture's two halves are taken one after the other

`src/adapters/shell-captures.ts:199` takes every base half in the detached base
tree, then `:220` takes every branch half in the run's worktree. Different
trees, so they are already isolated and already safe to overlap.

The larger version of the same point: the base checkout and its install are a
known cost from the moment the branch is named, and they are paid at the pull
request. They could be started in the background at `prepareWorkspace` and
awaited where the section is built. Modest for a repo whose capture is a
terminal frame; not modest for one whose capture is a simulator boot.

### 5. Only one skill fans out

The deny list is four rules about pushing, merging, reviewing and graphql
(`src/config.ts`), so the Agent tool is available to every stage today.
`skills/code-review/SKILL.md` is the only skill that uses it: it runs its two
axes as parallel sub-agents. Nothing else does.

`skills/security/SKILL.md` is a thirteen-item checklist matched against every
hunk, and read-only until its fix phase — a fan-out by construction. `to-spec`
and `plan` both open by exploring the repository, which is the same shape.

This is the cheapest of the seven: prompt and skill edits, no pipeline change,
no new race, because the sub-agents read and one session writes.

### 6. Recorded, not scoped — refactor, security and review as parallel readers and one writer

The three stages after `implement` all read the same diff and each writes a
findings file. As written they are three sequential sessions that each mutate
the worktree. Splitting them into parallel read-only finders plus a single
applier would collapse three stage runs into roughly one.

It is a redesign, not an addition, and it argues with three things at once: a
stage is one conversation by construction (`CONTEXT.md`), the driver's
`completed` list is decided per index (`src/pipeline/step.ts`), and the screen
assumes exactly one running step. Worth weighing on its own once the measured
durations exist.

### 7. Recorded, not scoped — more than one ticket at a time

The throughput answer, and most of the machinery is already built: worktrees
are keyed per run, and `runSweep` is a worked example of N isolated layer graphs
over one console with per-worker `archiveOnly` journals. ADR-0003 ruled that a
sweep hands out pull requests rather than tickets, for reasons about discovery
that do not apply to a fresh run.

What stops it is the budget in the constraints above and the screen, which
draws one run.

## Not findings

Two things that look parallel and are not:

- **spec → plan → implement** is a strict data chain; each stage reads what the
  one before it wrote to `.fabrika/work/`.
- **The two `agent.ask` calls in a review round** share `round-${round}`
  deliberately. They are one conversation, and one conversation is serial.

## Scope

In: findings 1 through 5. Out: 6 and 7, recorded above and left for their own
tickets.

Findings 1, 2 and 4 change no contract. Finding 3 adds a field to the gate
step schema and needs `fabrika init` to keep writing a config that does not use
it. Finding 5 touches skills and prompts only.

## Done when

- A review round's reviewer wait and checks wait run together, and the outline
  reports an open wait correctly while both are in flight.
- The failure-log, rerun, reply and resolve loops run with bounded concurrency.
- A gate step can declare that it may run alongside its siblings; a config that
  declares nothing runs exactly as it does today.
- A capture's two halves are taken together.
- The `security`, `to-spec` and `plan` skills fan out where their work is
  read-only, the way `code-review` already does.
- The rehearsal (`pnpm rehearse`) still shows a run whose waits, gate and
  captures read correctly on the screen.

## Assumptions

Recorded rather than asked, per the unattended rule; a human corrects them here
before the run.

- Concurrency limits are small constants rather than config. The sweep's
  `--concurrency` is an operator's choice because it spends the budget across
  pull requests; the limits in this ticket bound `gh` calls and host processes,
  which nobody wants to tune.
- The gate's parallel opt-in is per step and declarative, so the committed
  config keeps saying what the repo's checks are rather than how to schedule
  them.
- One combined `waitFor` is preferred to teaching the outline a second wait,
  unless finding 4's overlapping captures want one too — in which case the
  outline learns it once and both use it.
- Nothing here changes what escalates, or when.
