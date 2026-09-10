---
name: domain-modeling
description: Keep the project's domain model current while designing — resolve a term into CONTEXT.md, record a load-bearing decision as an ADR. Use when a spec, plan, or refactor names a concept the glossary lacks or contradicts, or settles a decision that is hard to reverse.
---

# Domain Modeling

Build and sharpen the project's domain model as you design: challenge terms against the glossary, pick canonical names, and write glossary entries and decisions down the moment they crystallise. Merely *reading* `CONTEXT.md` for vocabulary is a one-line habit any skill has; this skill is for changing the model.

## File structure

Most repos have a single context: `CONTEXT.md` at the root and `docs/adr/NNNN-slug.md`. A `CONTEXT-MAP.md` at the root means several contexts, each with its own `CONTEXT.md` and `docs/adr/`; infer the context from the code you are touching. Formats: [CONTEXT-FORMAT.md](CONTEXT-FORMAT.md), [ADR-FORMAT.md](ADR-FORMAT.md).

Create files lazily — only when you have something to write. A repo without `CONTEXT.md` gets one when the first term is resolved; `docs/adr/` when the first ADR is needed.

## Terms

- **Challenge against the glossary.** A term in the ticket, spec, or code that conflicts with `CONTEXT.md` is resolved in the glossary's favour; where the glossary is the one that is wrong (the code and the ticket agree against it), sharpen the entry and record why under Assumptions or Decisions.
- **Sharpen fuzzy language.** A vague or overloaded term ("account", "item", "session") gets one canonical name, chosen to match what the code already calls it most; the others go under `_Avoid_`.
- **Cross-reference with code.** Before defining a term, check what the code does with it. A definition that the code contradicts is not written; the contradiction goes into the spec's Assumptions.
- **Only project-specific concepts.** General programming concepts stay out even when the project uses them everywhere.
- **Update inline.** Write the entry the moment the term is resolved, in the format in CONTEXT-FORMAT.md. `CONTEXT.md` is a glossary and nothing else: no implementation details, no decisions.

## ADRs

Write an ADR only when all three hold:

1. **Hard to reverse** — changing your mind later costs something real.
2. **Surprising without context** — a future reader will wonder "why did they do it this way?".
3. **A real trade-off** — there were genuine alternatives and one was picked for specific reasons.

One missing → no ADR. A qualifying decision gets a one-paragraph ADR (ADR-FORMAT.md), numbered after the highest existing one. An existing ADR is never contradicted silently: a change that goes against one is recorded in the stage file with the conflict, and the ADR stays as it is for a human to reopen.

## Commit

Glossary and ADR changes ship in the ticket's PR. Commit each on its own, `docs: define <term>` or `docs: ADR-<n> <title>`, so a reviewer can see the model change apart from the code.
