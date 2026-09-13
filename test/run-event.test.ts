import assert from "node:assert/strict";
import { test } from "node:test";
import { plain, type RunEvent } from "../src/run-event.ts";

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
    "pipeline/steps/review.ts — the done: line",
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
