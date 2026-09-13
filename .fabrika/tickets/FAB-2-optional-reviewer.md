---
id: FAB-2
type: feat
---

# A repo without a review bot should still finish a run

## Problem

`fabrika run` cannot reach a clean exit on a repository that has no cubic
installation. Not "degrades" — cannot. The run does all six stages, opens the
draft PR, then waits `review.timeoutMinutes` for a review that will never
arrive and escalates with exit 2.

This was observed on fabrika's own repository during the FAB-1 run. The PR was
complete and its CI was green; the run still ended in an escalation, because
nothing in the pipeline can tell "the bot has not answered yet" from "there is
no bot".

The shape of the gap:

- `src/config.ts` — `provider: Schema.Literal("cubic")`. The config has a
  provider field that accepts exactly one provider.
- `src/run.ts` — `const reviewer = cubicReviewer.layer.pipe(...)`. The adapter
  is hardcoded regardless of what the field says.
- `src/pipeline/fabrika.ts` — `.step(reviewRounds)` is unconditional. There is
  no `only`, no flag, and no config that drops it.
- `README.md` lists cubic under Prerequisites as "For the review loop:",
  which reads as optional. It is not optional.

The irony is that the abstraction already exists and is good. `Reviewer` is a
clean port whose own doc comment says the loop "is written against this, not
against any one of them", and every other port in the repo has an in-memory
twin in `test/harness.ts`. What is missing is a second adapter and the wiring
to choose it — not a design.

## Solution

A run on a repo with no review bot keeps the half of the loop that still
works: the CI half.

Without a reviewer, a round should wait for the pushed commit's checks to
settle, hand any failing step's log to the agent in that round's own session,
let it fix them, run the gate, merge the base, push, and go again. It is done
when no check on the pushed commit is failing. It escalates after
`review.maxRounds` as it does today.

That is not a degraded mode with a piece sawn off. Waiting on CI, feeding
failures back to the session that wrote the code, and the one-rerun-per-flake
behaviour are the parts of the loop that carry their weight on any repo. Only
the bot's threads and its score go away.

## Behaviour wanted

**Configuring it.** `review.provider` becomes a union rather than a single
literal, with a value meaning "no automated reviewer". `fabrika init` should
choose it when the target repo has no review bot, the same way it reads the
gate off CI rather than guessing — and should say which it chose in its notes.

**The done line.** A run that finishes without a reviewer says so, and still
ends with the PR URL as the last line of stdout. It must not claim a score it
does not have.

**`fabrika init`, and the README.** Whatever `init` writes must be runnable
on the repo it just read. The README's Prerequisites entry stops implying
cubic is optional when it is load-bearing, and says what a run does without
one.

## The part most likely to be got wrong

Read `src/pipeline/steps/review.ts` before designing this. The round has two
exits that both test the same two values, and they mean opposite things:

```
if (scoreOk && threads.length === 0 && failed.length === 0)  → done
if (threads.length === 0 && failed.length === 0)             → escalate
```

The second exists because a bot that scored the branch low while leaving
nothing actionable would otherwise loop to `maxRounds` re-reading the same
verdict. With no reviewer, `threads` is always empty and `score` is always
null — so **every green-CI round falls into the escalate branch**, and the
feature ships doing exactly what it was written to fix. Whatever shape the
change takes, "no reviewer, no failing checks" has to resolve to done.

Note also that the `Reviewer` service is not optional in the layer graph:
`ghForge.layer` consumes it, using `reviewer.owns` to keep the bot's own
status check from being mistaken for repo CI. So "no reviewer" is an adapter
that answers the port, not an absent service — making it an `Option` ripples
through `run.ts` for no gain.

## Implementation decisions to make in the spec

- **What `await` returns when there is no bot.** Today `undefined` means
  "timed out" and escalates, so a null-reviewer cannot return it. Whether the
  answer is a synthetic empty `Review`, a new field on the port, or a
  narrower port, say which and why.
- **How the done-condition learns that a missing score is acceptable.** A
  property on the port reads better than a provider name compared in the
  loop, but that is a call for the spec to make and defend.
- **What happens to `renderThreads`, `decisionSchema` and `prompts`** on an
  adapter that never produces a thread. Dead stubs are one answer; a port
  that splits the thread-answering half from the waiting half is another.
  Prefer the one that leaves the cubic adapter unchanged.

## Constraints

- **The cubic path does not regress.** Its behaviour, its prompts and its
  thread-resolution rule — a claimed fix whose file no commit touched stays
  open — are unchanged. This ticket adds a second way through the loop.
- **`reviewer.owns` still has a job.** Whatever answers the port when there
  is no bot must still classify checks correctly, or the loop waits on a
  signal that is not there.
- **Exit codes hold.** 0 clean with the PR URL last on stdout, 2 escalated to
  stderr, 3 usage limit.
- **A config written by the current `init` still loads.** `provider: "cubic"`
  keeps meaning what it means; this widens the field, it does not move it.
- **Tested through the harness.** `test/harness.ts` has an in-memory reviewer
  already. The new path gets the same treatment — no network, milliseconds —
  and in particular a test that pins *green CI with no reviewer finishes the
  run* rather than escalating.

## Out of scope

- Writing an adapter for a second real review bot. This ticket is about
  running with none; a third provider is a separate adapter and one line in
  `src/run.ts`, which is the point of the port.
- Changing what cubic scoring means, `requireScore`, or `maxRounds`.
- Making the review step droppable from the pipeline entirely. The builder in
  `src/pipeline/fabrika.ts` already supports `.without()` for a caller that
  wants a different run; this ticket is about the shipped run doing the right
  thing.
- Any change to the six code stages.

## Done when

- A run on a repo with no review bot reaches a clean exit 0 with the PR URL
  last on stdout, having waited for CI and fixed what it could.
- A failing check on such a repo is still handed to the agent, fixed,
  gated, pushed, and re-checked, and still escalates after `maxRounds`.
- The cubic path behaves exactly as it does today.
- `fabrika init` writes a config that is runnable on the repo it read, and
  says which provider it chose.
- `README.md` states what a run does with and without a review bot.
- `pnpm compile`, `pnpm build` and `pnpm test` are green.
