---
name: improve-codebase-architecture
description: Find deepening opportunities in the code a branch touched, record them in .fabrika/work/refactor.md, implement the Strong ones, explore the rest. Use after implementation, before security and code review.
---

# Refactor pass

Surface architectural friction in the code this branch touched and turn shallow modules into deep ones where it pays. Vocabulary and principles come from `fabrika:codebase-design` — **module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**; the deletion test; "the interface is the test surface"; "one adapter = hypothetical seam, two = real". Use those terms exactly.

## 1. Scope

The scope is the modules this branch changed (`git diff --name-only <base>...HEAD`) plus their immediate callers and callees. Deepening pays off where change is happening, and a ticket's PR stays reviewable when its refactors stay near its feature. Code outside the scope is recorded as a candidate and left unchanged.

Read `CONTEXT.md` and any ADRs in the area first. An ADR settles a decision: a candidate that contradicts one is recorded with the conflict, never implemented.

## 2. Explore

Walk the scope (a sub-agent is fine) and note where you feel friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where were pure functions extracted for testability while the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts are untested, or only testable past their interface?

Apply the **deletion test** to anything you suspect is shallow: deleting it would concentrate complexity → a candidate; deleting it would just move complexity → leave it.

## 3. Record

Write `.fabrika/work/refactor.md`, one entry per candidate:

```
## <candidate>
- **Files**: ...
- **Problem**: why the current shape causes friction
- **Solution**: what would change, in plain English
- **Benefits**: locality and leverage gained; how the tests improve
- **Strength**: Strong | Worth exploring | Speculative
- **ADR conflict**: none | ADR-<n> — why the friction may warrant reopening it
- **Status**: filled in step 4
```

No candidates is a valid outcome; the file then says so and why.

## 4. Decide and act

- **Strong** → implement, unless it has an ADR conflict or reaches outside the scope. Classify the module's dependencies per [DEEPENING.md](../codebase-design/DEEPENING.md), then work through `fabrika:tdd`: tests at the deepened interface first, then the restructuring, then delete the old tests on the shallow modules once the new ones cover them (replace, don't layer). One commit per candidate, message starting `refactor:`.
- **Worth exploring** → a bounded look: read the code paths, sketch the deepened interface, count the adapters that would sit at the seam. Promote to Strong and implement, or leave it with the reason.
- **Speculative** → recorded only.

Set each Status to `done (<commit>)`, `declined: <reason>`, or `recorded`.

Side effects go through the `fabrika:domain-modeling` skill as they happen: a deepened module named after a concept not in `CONTEXT.md` gets its glossary entry; a Strong candidate declined for a load-bearing reason (one a future refactor pass would need in order not to re-suggest it) gets an ADR.

## Done

Every candidate has a Status; typecheck and the test suite are green locally; everything is committed.
