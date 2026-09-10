---
name: to-spec
description: Turn a ticket into a spec at .fabrika/work/spec.md — problem, solution, user stories, seams, testing decisions, assumptions. Use at the start of a fabrika run, before planning.
---

# Spec

Write the spec for a ticket without an interview. The ticket text, the codebase, and the decisions you make yourself are the only inputs. Every question an interview would have asked becomes an assumption you choose and record; a human reads that list first.

## Process

1. **Explore** the repository around the area the ticket touches. Read `CONTEXT.md` and ADRs (`docs/adr/`) where they exist and use their vocabulary; follow the conventions the repo documents (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`). Where the ticket names behaviour, find the code that has it today. A fact about a library or external API that the code cannot answer goes through the `fabrika:research` skill.

2. **Name the concepts.** A term the ticket uses that `CONTEXT.md` lacks, or uses differently, is resolved with the `fabrika:domain-modeling` skill before the spec uses it; the spec then uses the canonical term throughout.

3. **Choose the seams** the feature will be tested at, in the `fabrika:codebase-design` vocabulary. Prefer existing seams to new ones. Use the highest seam that can observe the behaviour. The fewer seams the better; the ideal number is one. A new seam carries a written reason.

4. **Write** `.fabrika/work/spec.md` (create the directory) from the template below.

5. **Done** when every section is filled and every entry under Assumptions carries the answer chosen and why. Beyond the spec and what `fabrika:domain-modeling` wrote, change no other file.

<spec-template>

# <ticket id>: <title>

## Problem Statement

The problem from the user's perspective.

## Solution

The solution from the user's perspective.

## User Stories

A long numbered list, each `As a <actor>, I want <feature>, so that <benefit>`. Cover every aspect of the feature, including error paths and edge cases.

## Implementation Decisions

Modules built or modified, their interfaces, architectural decisions, schema changes, API contracts, specific interactions. Prose and interface shapes, not file paths or code — those go stale. Exception: a snippet that encodes a decision more precisely than prose (a state machine, a schema, a type shape), trimmed to the decision-rich part.

## Testing Decisions

- The seams under test, each with why it is the right seam.
- Which modules are tested through them.
- Prior art: existing tests in this repo the new ones should resemble.
- What makes a good test here: external behaviour through the interface, expected values from an independent source of truth.

## Out of Scope

What this ticket does not do.

## Assumptions

Every question an interview would have asked, with the answer chosen and the reason:

- **<question>** — <answer>. Why: <one sentence>.

</spec-template>
