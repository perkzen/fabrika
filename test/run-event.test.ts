import assert from "node:assert/strict";
import { test } from "node:test";
import { plain, type RunEvent } from "../src/domain/run-event.ts";

/**
 * One row per call site converted from a string to an event. Every expected
 * value is the literal string that call site produced before the conversion,
 * written out by hand — this table is the whole guarantee that a pipe reading
 * fabrika's output sees the same bytes it saw yesterday.
 */
const fidelity: ReadonlyArray<[string, RunEvent | string, ReadonlyArray<string>]> = [
  [
    "pipeline/step.ts — a skipped step",
    { kind: "step", name: "refactor", at: 5, of: 9, state: "skipped", reason: "fix ticket" },
    ["refactor: skipped (fix ticket)"],
  ],
  [
    "pipeline/step.ts — a step a resume has already done",
    { kind: "step", name: "spec", at: 4, of: 9, state: "already-done" },
    ["spec: already done"],
  ],
  [
    "pipeline/step.ts — a resumed run",
    { kind: "run", completed: ["spec", "plan"], steps: [{ name: "spec", done: true }, { name: "implement", done: false }] },
    ["resuming after spec, plan", "steps: spec, implement"],
  ],
  [
    "pipeline/step.ts — a step that ended cleanly",
    { kind: "step", name: "refactor", at: 5, of: 9, state: "end", seconds: 533, outcome: "done" },
    ["step refactor: done (8m 53s)"],
  ],
  [
    "pipeline/step.ts — a step that ended badly",
    { kind: "step", name: "review", at: 9, of: 9, state: "end", seconds: 41, outcome: "failed" },
    ["step review: failed (41s)"],
  ],
  [
    "adapters/shell-gate.ts — a gate step starting",
    { kind: "gate", name: "compile", at: 1, of: 2, command: "tsc --noEmit", state: "start" },
    ["gate compile: tsc --noEmit"],
  ],
  [
    "adapters/shell-gate.ts — a gate step passing",
    { kind: "gate", name: "compile", at: 1, of: 2, command: "tsc --noEmit", state: "pass", seconds: 3 },
    ["gate compile: ok (3s)"],
  ],
  [
    "adapters/shell-gate.ts — a gate step failing",
    { kind: "gate", name: "lint", at: 2, of: 2, command: "eslint .", state: "fail", seconds: 12, exitCode: 1 },
    ["gate lint: FAILED (exit 1, 12s)"],
  ],
  [
    "adapters/shell-gate.ts — a gate step with no matching changes",
    { kind: "gate", name: "docs", at: 1, of: 2, command: "true", state: "skipped" },
    ["gate docs: skipped (no matching changes)"],
  ],
  [
    "pipeline/step.ts — the done: line the driver writes",
    {
      kind: "result",
      outcome: "done",
      text: "done: cubic 5/5, no open threads, checks green — ready for human review: https://github.com/perkzen/fabrika/pull/7",
    },
    ["done: cubic 5/5, no open threads, checks green — ready for human review: https://github.com/perkzen/fabrika/pull/7"],
  ],
];

for (const [site, entry, expected] of fidelity) {
  test(`plain() reproduces the line ${site} wrote`, () => {
    assert.deepEqual(plain(entry), expected);
  });
}

test("a bare string is one entry per physical line, so every surface can stamp each", () => {
  assert.deepEqual(plain("artifacts: spec.md\nplan.md"), ["artifacts: spec.md", "plan.md"]);
});

test("a detail note keeps the two-space indent the sub-lines are written with today", () => {
  assert.deepEqual(plain({ kind: "note", level: "detail", text: "reran 2 failed run(s) once in case of flakes" }), [
    "  reran 2 failed run(s) once in case of flakes",
  ]);
});

test("elapsed reads in seconds below a minute and in minutes and seconds above it", () => {
  assert.deepEqual(plain({ kind: "wait", state: "end", subject: "the agent", seconds: 12 }), ["waited 12s for the agent"]);
  assert.deepEqual(plain({ kind: "wait", state: "end", subject: "the agent", seconds: 252 }), ["waited 4m 12s for the agent"]);
  assert.deepEqual(plain({ kind: "wait", state: "end", subject: "the agent", seconds: 60 }), ["waited 1m 0s for the agent"]);
});

test("a tool call and a cost read as the sub-lines they are", () => {
  assert.deepEqual(plain({ kind: "tool", stage: "implement", tool: "Read", subject: "src/cli.ts" }), ["  Read src/cli.ts"]);
  assert.deepEqual(plain({ kind: "tool", stage: "implement", tool: "MysteryTool", subject: "" }), ["  MysteryTool"]);
  assert.deepEqual(plain({ kind: "cost", stage: "implement", usd: 1.5 }), ["  (implement: $1.50)"]);
});

/**
 * The two poll loops that became a wait. The start lines are what they wrote
 * once a poll; gh-forge's parenthetical is the one converted call site whose
 * plain rendering is deliberately not byte-identical.
 */
test("a wait's start line is what the poll loop wrote per poll", () => {
  assert.deepEqual(plain({ kind: "wait", state: "start", subject: "cubic-dev-ai review of abc1234", deadlineMinutes: 25 }), [
    "waiting for cubic-dev-ai review of abc1234",
  ]);
  assert.deepEqual(plain({ kind: "wait", state: "start", subject: "checks on abc1234", deadlineMinutes: 20 }), [
    "waiting for checks on abc1234",
  ]);
});

/**
 * A run event's text is not the run's own words. It carries what the agent
 * said, what a tool was called with, and what `gh` handed back — all of it
 * derived from repo files, review threads and fetched pages, none of it
 * trusted with the operator's terminal.
 */
test("a control character in an event's text never reaches a surface", () => {
  assert.deepEqual(
    plain({ kind: "agent", stage: "implement", markdown: "all good \x1b[2J\x1b[H\x1b]52;c;cHduZWQ=\x07 done" }),
    ["all good [2J[H]52;c;cHduZWQ= done"],
    "the escape byte goes and the rest stays visible, so the attempt is legible rather than obeyed",
  );
  assert.deepEqual(
    plain({ kind: "note", level: "warn", text: "[retry] overloaded\rdone: ready for human review" }),
    ["[retry] overloadeddone: ready for human review"],
    "a carriage return can overwrite the line it is on, which is how a failure forges a success",
  );
  assert.deepEqual(plain({ kind: "tool", stage: "implement", tool: "Bash", subject: "run \x1b[31mtests" }), ["  Bash run [31mtests"]);
  assert.deepEqual(plain("wrote \x07.fabrika/config.json"), ["wrote .fabrika/config.json"]);
});

test("scrubbing keeps the characters a line is actually made of", () => {
  assert.deepEqual(plain({ kind: "note", level: "info", text: "one\ttwo\nthree — ✓ │ ünïcode" }), ["one\ttwo", "three — ✓ │ ünïcode"]);
});
