---
status: accepted
---

# A stage's `when` skip requires positive evidence, so an empty diff never skips

A stage and a gate step both carry `when` globs, both matched against the same
changed files by the same `matchesAny`, and they deliberately disagree about the
empty list: a gate step with `when` and no changed files skips, a stage runs.
The asymmetry is the point. A gate step runs inside a stage that has already
produced a diff, so an empty list there is a real answer; a stage's filter is
asked at the stage's turn, and `spec` and `plan` are reached before any tracked
file has changed — `.fabrika/work/` is git-excluded — so a `when` that skipped
on no evidence would skip forever and silently delete work from the run. A skip
therefore needs a diff that exists and misses; the absence of evidence is never
grounds for removing a stage.

The cost of this is that a `when` on a stage which runs before anything has
changed is a documented no-op — it makes the stage unconditional rather than
skipped — and the run's log shows it running.

## Considered Options

- **Reject such a config at preflight**, so the no-op is unrepresentable.
  Rejected because the host cannot know statically which stage first changes a
  tracked file. `gate: true` is the nearest proxy and is wrong in both
  directions: it would reject a valid config whose first code-producing stage is
  ungated, and admit an invalid one whose gated stage writes nothing.
- **Put the empty-list rule inside `matchesAny`**, so one function carries the
  whole meaning of `when`. Rejected: it would flip the gate to running a `when`
  step on an empty diff, changing behaviour this ticket promised to leave alone.
  The rule lives in `codeStage`'s guard instead, and the matcher stays a pure
  "does any of these files match any of these globs".
