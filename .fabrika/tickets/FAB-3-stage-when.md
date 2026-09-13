---
id: FAB-3
type: feat
---

# A stage should run when the change needs it, not when the ticket type matches

## Problem

Which stages run is decided by one field, `only`, matched against the
ticket's type:

```
{ name: "refactor", ..., only: ["feat"] }
```

That is too blunt in both directions, and the FAB-1 run showed both:

- A `feat` that is forty lines of README still pays for `refactor` — a cold
  start plus a full gate run. On the FAB-1 run `refactor` cost **$9.04** of
  **$52.68**.
- A `fix` or `chore` that rewrites a module gets no `refactor` at all, because
  the type says so.

The type is not even a property of the ticket. It comes from the
`fabrika:branch-naming` call at the start of the run and is recorded in
`state.json`. So the decision about which stages run is *already* a model's
judgement — just laundered through a three-valued enum chosen for naming a
branch, and made before a single file has changed.

Meanwhile the gate — one layer down — already has the better mechanism:

```
/** Glob patterns; the step runs only when a changed file matches one. */
when: Schema.optional(Schema.Array(Schema.String)),
```

`shell-gate.ts` matches those against `workspace.changedFiles`
(`git diff --name-only base...HEAD`) and skips the step when nothing matches.
Stages have no equivalent.

## Solution

Give a stage the same `when` that a gate step has, matched the same way
against the branch's diff. A stage with `when` runs only when the change so
far touches a file matching one of its globs.

`refactor` becomes "runs when `src/**` changed" rather than "runs for feat
tickets". A docs-only change skips it without anyone judging anything, and a
`chore` that rewrites a module gets it.

`only` stays. The two answer different questions — "is this the kind of
ticket" and "did this change touch the kind of file" — and a stage may use
either, both, or neither.

## The security stage is not eligible for this, and here is why

`security` has no `only` today, deliberately: "a small diff is a small
security review". This ticket does not give it a `when` either, and the FAB-1
run is the reason.

FAB-1's ticket was *"make the terminal output legible"*. Nothing in its text
is security-relevant. Its `security` stage produced:

```
94a532d fix(security): a terminal obeys what it is sent, so an event's text is scrubbed
```

An ANSI escape injection — introduced *by* the change. The previous code's
`.replace(/\n/g, " ")` and 400-character truncation had been incidentally
sanitising escape sequences; rendering markdown properly removed that accident
and opened the hole. The vulnerability did not exist in the ticket, was not
predictable from the ticket, and lived only in the diff.

At **$4.23** it was the cheapest stage in the run.

So: no `when` on `security`, and whatever mechanism this ticket adds must not
become a route to skipping it. If a repo genuinely does not want the stage, it
deletes it from `stages` — a visible, committed, reviewable act.

## Behaviour wanted

**`when` on a stage**, same field name, same glob semantics, same matcher as
`GateStep.when`. A stage that skips says so with its reason, in the form the
existing skip lines already use.

**A stage with no diff yet does not silently skip.** `spec` and `plan` run
before any file has changed, and their artifacts live in `.fabrika/work/`,
which is excluded from git — so `changedFiles` is empty for them. A `when` on
a stage in that position would always skip. The spec decides whether that is a
config error rejected up front or a documented no-op, and says which.

**`fabrika init` writes globs that fit the repo it read.** It already derives
the gate from CI and, with FAB-2, the review provider. The `when` it puts on
`refactor` should reflect where that repo's source actually lives, and its
notes should say what it chose.

## The part most likely to be got wrong

`skip` is evaluated before the step runs, and per `docs/internals.md` a
skipped step **is not recorded in `completed`**, so its reason is reconsidered
on the next run. That is correct for `only`, whose input cannot change.

A `when` glob's input *does* change: the diff grows as stages commit. A
resumed run re-evaluates the skip against a larger diff, so a stage that
skipped on the first pass can run on the second. Decide whether that is the
intended behaviour — it probably is, since the diff is the thing being judged
— and pin it with a test either way. What must not happen is a stage running
twice, or a resume producing a different pipeline for reasons nobody can see
in the log.

Pin also what the diff is measured against. `workspace.changedFiles` is
`base...HEAD` — the whole branch — while `workspace.filesSince(sha)` answers a
narrower question. `refactor` almost certainly wants the whole branch; say so
and test it.

## Constraints

- **`only` keeps working exactly as it does now.** A config written before
  this change produces an identical pipeline.
- **`security` gets no `when`.** See above.
- **The gate's `when` is untouched.** If the matcher is shared, it moves to
  one place without changing gate behaviour; the gate's tests stay green.
- **A skip is visible.** The reason appears in the log and in `log.txt`, in
  the shape the console now renders, so reading a run tells you which stages
  did not run and why.
- **Tested through the harness.** In-memory workspace, no git: a stage whose
  globs miss skips, one whose globs hit runs, a stage with both `only` and
  `when` needs both, and a resume against a grown diff behaves as pinned.
- Exit codes and the piped contract are unchanged.

## Out of scope

- **The judge — deliberately deferred, with its rules recorded here.** An
  agent deciding the pipeline per ticket is a real idea and not this ticket.
  When it is built it inherits three constraints from the FAB-1 evidence
  above:
  1. It reads **the diff, not the ticket**, and therefore cannot run before
     `implement` has produced one.
  2. It may not skip `security`.
  3. The host validates its answer and ignores an unusable one, the way
     `asProposal` in `src/configure.ts` already rejects a bad `init` proposal.
     A model proposes; the host decides.
  Globs first because they are deterministic, committed and readable in a
  diff — the 80% that needs no judgement at all.
- Changing what any stage does, or the order of `stages`.
- Reducing the cost of `spec` and `plan`. They were **$15.40** of the FAB-1
  run — more than `refactor` and `security` together — and they run before
  there is anything to judge. That is a different ticket.
- The reviewer work in FAB-2.

## Done when

- A stage may carry `when`, matched against the branch's changed files with
  the same semantics as a gate step's.
- A docs-only change skips `refactor` on a `feat` ticket; a `chore` that
  touches `src/**` runs it.
- `security` has no `when` and runs on every ticket.
- A config with `only` and no `when` produces exactly today's pipeline.
- Skips and their reasons are visible in the run's output and in `log.txt`.
- A resumed run's stage selection is pinned by a test.
- `pnpm compile`, `pnpm build` and `pnpm test` are green.
