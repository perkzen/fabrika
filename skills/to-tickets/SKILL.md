---
name: to-tickets
description: Break a plan, spec, or the current conversation into tracer-bullet tickets as local markdown files that `fabrika run --file` accepts, each declaring what blocks it. Use when the user wants work split into tickets without touching the team's Linear.
---

# To Tickets

Break a plan, spec, or conversation into **tickets** — tracer-bullet vertical slices, each declaring the tickets that **block** it — written as local files, so the team's tracker stays clean and each file is runnable on its own.

## Process

### 1. Gather context

Work from what is already in the conversation. A reference passed as an argument (a spec path, a Linear URL) is fetched and read in full, comments included.

### 2. Explore the codebase

Understand the current state of the code the work touches. Titles and descriptions use the glossary vocabulary in `CONTEXT.md` and respect ADRs in the area. Look for **prefactoring** that would make the change easy — "make the change easy, then make the easy change" — and put it first.

### 3. Draft vertical slices

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, not one layer.
- A completed slice is demoable or verifiable on its own.
- Each slice is sized for one fabrika run: a single fresh context window.
- Prefactoring comes first.

</vertical-slice-rules>

Give each ticket its **blocking edges** — the tickets that must complete first. A ticket with no blockers can start immediately.

**Wide refactors are the exception.** A mechanical change with a **blast radius** across the whole codebase (rename a column, retype a shared symbol) cannot land green as one slice. Sequence it as **expand–contract**: expand (add the new form beside the old), migrate in batches sized by blast radius, each batch blocked by the expand, then contract (delete the old form) blocked by every batch.

### 4. Quiz the user

Present the breakdown as a numbered list: **Title**, **Blocked by**, **What it delivers**. Ask whether the granularity feels right, whether the blocking edges are real, and what to merge or split. Iterate until approved. (In an unattended run there is no user: take the breakdown as drafted and record that in each ticket's Notes.)

### 5. Write the files

One file per ticket under `.fabrika/tickets/<feature-slug>/<NN>-<slug>.md`, numbered from `01` in dependency order, blockers first. The format is the one `fabrika run --file` reads: frontmatter, then an H1 title, then the body.

<ticket-template>

```markdown
---
id: <feature-slug>-<NN>
type: feat | fix | chore
---
# <Ticket title>

## What to build

The end-to-end behaviour this ticket makes work, from the user's perspective — not a layer-by-layer list.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

- `<NN>-<slug>` — <title>, or "None — can start immediately".

## Notes

Decisions from the conversation the implementer needs. No file paths or code snippets — they go stale. Exception: a prototype's snippet that encodes a decision more precisely than prose (a state machine, a schema, a type shape), trimmed to the decision-rich part.
```

</ticket-template>

Then tell the user the run order — the **frontier** is every ticket whose blockers are done — and the command for the first one:

```bash
/path/to/fabrika/node_modules/.bin/tsx /path/to/fabrika/src/cli.ts run --file .fabrika/tickets/<feature-slug>/01-<slug>.md
```

Modify no parent issue or tracker.
