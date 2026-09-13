import assert from "node:assert/strict";
import { test } from "node:test";
import { outline } from "../src/outline.ts";
import type { RunEvent } from "../src/run-event.ts";

/** Local noon on a fixed day, so a stamped entry reads the way the console's does. */
const noon = new Date(2026, 0, 1, 12, 0, 0).getTime();

/** A scripted run: seconds from noon, and the event that arrived then. */
const script = (...events: ReadonlyArray<readonly [number, RunEvent | string]>) =>
  outline(events.map(([seconds, entry]) => ({ at: noon + seconds * 1000, entry })));

const RUN: RunEvent = {
  kind: "run",
  completed: ["spec"],
  steps: [{ name: "spec", done: true }, { name: "implement", done: false }, { name: "review", done: false }],
};

test("a run event becomes a root with one pending node per step", () => {
  const tree = script([0, RUN]);

  assert.equal(tree.roots.length, 1, "one run, one root");
  assert.deepEqual(
    tree.roots[0]!.children.map((node) => [node.at, node.of, node.name, node.state]),
    [
      [1, 3, "spec", "already-done"],
      [2, 3, "implement", "pending"],
      [3, 3, "review", "pending"],
    ],
    "the step list the run announces, with the resumed step already behind it",
  );
  assert.equal(
    new Set(tree.roots[0]!.children.map((node) => node.key)).size,
    3,
    "keys are unique, so a pipeline with two steps of one name is still two rows",
  );
});

test("a finished step's summary is the arithmetic of the events inside it", () => {
  const tree = script(
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [2, { kind: "tool", stage: "implement", tool: "Bash", subject: "pnpm test" }],
    [3, { kind: "tool", stage: "implement", tool: "Read", subject: "src/cli.ts" }],
    [4, { kind: "cost", stage: "implement", usd: 0.25 }],
    [5, { kind: "tool", stage: "implement", tool: "Bash", subject: "git commit" }],
    [6, { kind: "tool", stage: "implement", tool: "Edit", subject: "src/cli.ts" }],
    [7, { kind: "gate", name: "compile", at: 1, of: 2, command: "tsc", state: "pass", seconds: 3 }],
    [8, { kind: "gate", name: "test", at: 2, of: 2, command: "pnpm test", state: "fail", seconds: 41, exitCode: 1 }],
    [9, { kind: "cost", stage: "implement", usd: 0.5 }],
    [533, { kind: "step", name: "implement", at: 2, of: 3, state: "end", seconds: 533, outcome: "done" }],
  );

  const step = tree.roots[0]!.children[1]!;
  assert.equal(step.state, "done");
  assert.deepEqual(step.summary, {
    seconds: 533,
    usd: 0.75,
    calls: 4,
    // Descending by count and then by name, so Edit and Read cannot swap places
    // between two runs of the same events.
    tools: [{ tool: "Bash", count: 2 }, { tool: "Edit", count: 1 }, { tool: "Read", count: 1 }],
    skills: [],
    gates: [
      { name: "compile", state: "pass", seconds: 3 },
      { name: "test", state: "fail", seconds: 41 },
    ],
  });
});
