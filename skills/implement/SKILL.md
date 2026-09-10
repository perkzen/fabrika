---
name: implement
description: Implement .fabrika/work/plan.md slice by slice through tdd, keeping the plan honest as you go. Use in the implement stage, after the plan and before the architecture pass.
---

# Implement

Execute the plan another session wrote: one slice at a time, test-first, committed as you go.

## Process

1. **Read** `.fabrika/work/plan.md` and `.fabrika/work/spec.md`. The seams under test are the spec's Testing Decisions; the slices are the order of work.

2. **Work each slice** through the `fabrika:tdd` skill: the failing test named in the slice, the minimal code that passes it, one commit. Shape any new interface with the `fabrika:codebase-design` vocabulary — accept dependencies, return results, keep the surface small. Comment per `fabrika:code-comments`: why over what, short doc comments on the exported interface only.

3. **Keep the plan honest.** When a slice turns out wrong — the seam is not where the plan said, the test cannot be written as named, a later slice is already covered — amend the plan file before continuing and say why in the commit message. The plan at the end describes what was built.

4. **Check as you go.** Typecheck after each green; run the slice's test file each cycle; run the full suite once when the last slice is done.

## Done

Every slice in the plan is a passing test, typecheck and the full suite are green locally, and everything is committed. Refactoring waits for the architecture pass; review waits for the review stage.
