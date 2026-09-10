---
name: plan
description: Turn .fabrika/work/spec.md into an ordered implementation plan at .fabrika/work/plan.md — vertical slices, each a test and the code that passes it — then grill it. Use after the spec, before implementing.
---

# Plan

Produce the plan another session will execute: concrete, ordered, and already stress-tested.

## Process

1. **Read** `.fabrika/work/spec.md`. Explore the code the spec touches until you can name the files and functions involved and the prior-art tests the new ones will resemble.

2. **Write** `.fabrika/work/plan.md` from the template below. The first slice is the **tracer bullet**: the thinnest end-to-end path through every layer the feature touches. Every later slice adds one behaviour.

3. **Grill** the plan with the `fabrika:grill-with-docs` skill. It fills `## Decisions`; fold what it settles back into Goal, Slices, and Files.

4. **Done** when every slice names a test, a seam from the spec, and the code that passes it; every risk has a mitigation or a recorded acceptance; and the grill's frontier is empty. Beyond the plan and what `fabrika:domain-modeling` wrote, change no other file.

<plan-template>

# Plan: <ticket id>

## Goal

One paragraph restating the goal in your own words.

## Slices

Ordered vertical slices, each one red→green cycle at a seam from the spec:

1. **<test name>** — asserts <behaviour>. Seam: <seam>. Makes it pass: <file/function created or changed, one line each>.

## Files

Every file to change or create, one line on what changes.

## Risks

What could go wrong, what is uncertain, and what to do about each.

## Decisions

Filled by `fabrika:grill-with-docs`.

</plan-template>
