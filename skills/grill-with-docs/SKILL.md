---
name: grill-with-docs
description: Stress-test a plan without a human — walk its design tree in rounds, look up every fact, choose the recommended answer for every decision, record each one. Use when a plan needs grilling in an unattended run.
---

# Grill

Interrogate the plan relentlessly until nothing is left silently assumed. Map it as a **design tree**: every decision branches into the decisions that hang off it. You ask the questions and you answer them; there is no user.

## Rounds

The **frontier** is every decision whose prerequisites are already settled. Work it in rounds:

1. Write out the whole frontier, numbered. For each question give the candidate answers and the recommended one.
2. Settle each question:
   - A **fact** question (what does this code do, what does the config say, how does the existing test do it) is answered by looking: read the code, run a command, dispatch a sub-agent. A fact about a library, API, or platform that the codebase cannot answer goes through the `fabrika:research` skill. Facts come from sources, never from assumption.
   - A **decision** question is answered by taking the recommended answer. Tie-breakers, in order: what the spec says; what the repo already does elsewhere; the smallest change that satisfies the spec; the choice that is easiest to reverse.
3. Settled questions push the frontier outward. Recompute it and start the next round. A question whose answer depends on another still open in this round belongs to the next round.

Ask a question only when its answer would change a line of the plan. A question whose every answer leaves the plan unchanged is skipped.

## Record

Append each settled question to `## Decisions` in `.fabrika/work/plan.md`:

```
- **Q<n> <title>** — <answer taken>. Why: <one sentence>. (fact | decision)
```

Then revise the plan sections the answer touches.

A decision that is hard to reverse, surprising without context, and the result of a real trade-off also becomes an ADR through the `fabrika:domain-modeling` skill; a term the plan coins gets its glossary entry the same way.

## Done

The frontier is empty: every branch of the tree visited, every decision recorded in the plan. Implementation belongs to a later stage.
