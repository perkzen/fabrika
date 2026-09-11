---
name: code-review
description: Two-axis review of the branch diff — Standards (repo coding standards plus a smell baseline) and Spec (.fabrika/work/spec.md) — then fix the findings and write the PR description. Use as the last stage before the PR opens.
---

# Code review

Two-axis review of the diff between the base and `HEAD`, followed by fixes:

- **Standards** — does the code conform to this repo's documented coding standards and the smell baseline?
- **Spec** — does the code faithfully implement `.fabrika/work/spec.md`?

The axes stay separate so one cannot mask the other: code that follows every standard but implements the wrong thing fails Spec; code that does exactly what was asked but breaks conventions fails Standards.

## 1. Pin the diff

The fixed point is the base given in the stage prompt. Capture `git diff <base>...HEAD` (three-dot, against the merge-base) and `git log <base>..HEAD --oneline`. Confirm the ref resolves and the diff is non-empty before going further.

## 2. Sources

- **Spec**: `.fabrika/work/spec.md`, with `## Decisions` in `.fabrika/work/plan.md` for intent. `.fabrika/work/refactor.md` and `.fabrika/work/security.md` record the refactors and fixes the earlier stages added on purpose; a change they account for is intended, not creep. Either file may be absent — that stage did not run for this ticket, which says nothing about the changes themselves; judge them against the spec.
- **Standards**: whatever the repo documents — `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `CODING_STANDARDS.md`, `docs/` — plus the smell baseline below and the comment rules in `fabrika:code-comments`. A documented repo standard wins over the baseline. Skip anything tooling already enforces (lint, format, typecheck).

### Smell baseline

Fowler smells (_Refactoring_, ch. 3). Each is a labelled judgement call, never a hard violation; each reads *what it is* → *how to fix*:

- **Mysterious Name** — a name that doesn't reveal what it does or holds. → rename; if no honest name comes, the design is murky.
- **Duplicated Code** — the same logic shape in more than one hunk or file. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move it onto the data it envies.
- **Data Clumps** — the same few fields or params travelling together. → one type, passed whole.
- **Primitive Obsession** — a primitive standing in for a domain concept. → a small type for the concept.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type in several places. → polymorphism, or one shared map.
- **Shotgun Surgery** — one logical change forcing scattered edits across many files. → gather what changes together.
- **Divergent Change** — one module edited for several unrelated reasons. → split so each changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks for needs the spec doesn't have. → delete; inline until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → one method on the first object.
- **Middle Man** — a function that mostly delegates onward. → cut it, call the target.
- **Refused Bequest** — an implementer that ignores most of what it inherits. → composition.

## 3. Review both axes

Run the two axes as parallel sub-agents when the Agent tool is available — each gets the diff command, the commit list, its sources, and its brief; the Standards agent gets the smell baseline pasted in full. Without sub-agents, run the axes one after the other, each from a fresh read of the diff.

- **Standards brief**: report, per file or hunk, (a) every place the diff violates a documented standard, citing the file and rule; (b) every baseline smell, named, quoting the hunk; (c) every comment that breaks a `fabrika:code-comments` rule, quoting it. Mark each as *hard violation* or *judgement call*. Under 400 words.
- **Spec brief**: report (a) requirements missing or partial; (b) behaviour not asked for (scope creep); (c) requirements that look implemented but wrong. Quote the spec line for each. Under 400 words.

Write both reports to `.fabrika/work/review.md` under `## Standards` and `## Spec`, unmerged and unranked.

## 4. Fix

- Every hard Standards violation and every Spec finding: fix, test-first where behaviour changes (`fabrika:tdd`), one commit per finding.
- Scope creep: remove it, unless `spec.md` Assumptions, `refactor.md`, or `security.md` record it as intended.
- Judgement calls: fix when the fix stays inside one module; otherwise leave with the reason.

Append `## Fixes` to `review.md`: one line per finding, `fixed (<commit>)` or `left: <reason>`.

## 5. PR description

Write `.fabrika/work/pr.md`; the host posts it verbatim as the pull request body:

```
## Summary
What changed and why, three to six lines.

## Assumptions to check
The Assumptions from spec.md and the Decisions from plan.md a reviewer should confirm.

## Refactors
Refactor candidates implemented, one line each (from refactor.md), or "none".

## Security
Findings fixed or accepted (from security.md), or "no findings".

## Testing
Seams tested and the command that runs the tests.
```

## Done

Every finding has a line under Fixes, `pr.md` exists, typecheck and the test suite are green locally, everything is committed.
