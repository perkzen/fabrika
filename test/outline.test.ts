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

test("events are attributed to the open step, never to their stage field", () => {
  const tree = script(
    [0, RUN],
    [1, "the branch is perkzen/feat/FAB-6"],
    [2, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    // `stage` is the agent's label for one call — the review loop makes calls
    // under `ci` and `cubic-gate` — so it says nothing about which step is open.
    [3, { kind: "tool", stage: "ci", tool: "Bash", subject: "pnpm test" }],
    [4, { kind: "step", name: "implement", at: 2, of: 3, state: "end", seconds: 9, outcome: "done" }],
    [5, { kind: "note", level: "info", text: "PR https://github.com/perkzen/fabrika/pull/7" }],
  );

  const [root] = tree.roots;
  assert.deepEqual(
    root!.children.map((step) => step.stream.length),
    [0, 1, 0],
    "the tool call is the open step's, whatever it calls its stage",
  );
  assert.deepEqual(
    root!.stream.map(({ entry }) => (typeof entry === "string" ? entry : entry.kind)),
    ["the branch is perkzen/feat/FAB-6", "note"],
    "before the first start and after the last end there is no open step, so the events are the run's",
  );
  assert.equal(root!.children[1]!.summary.calls, 1);
});

test("a Skill tool call names an invoked skill, and the same skill twice is one", () => {
  const tree = script(
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [2, { kind: "tool", stage: "implement", tool: "Skill", subject: "fabrika:tdd" }],
    [3, { kind: "tool", stage: "implement", tool: "Bash", subject: "pnpm test" }],
    [4, { kind: "tool", stage: "implement", tool: "Skill", subject: "fabrika:code-comments" }],
    [5, { kind: "tool", stage: "implement", tool: "Skill", subject: "fabrika:tdd" }],
    // An unknown tool has no subject to name, and a nameless skill is no skill.
    [6, { kind: "tool", stage: "implement", tool: "Skill", subject: "" }],
  );

  const step = tree.roots[0]!.children[1]!;
  assert.deepEqual(step.summary.skills, ["fabrika:tdd", "fabrika:code-comments"], "first-use order, deduplicated");
  assert.equal(step.summary.calls, 5, "an invoked skill is still a tool call");
});

test("a skipped step carries its reason instead of a summary", () => {
  const tree = script(
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "skipped", reason: "fix ticket; runs for feat" }],
  );

  const step = tree.roots[0]!.children[1]!;
  assert.equal(step.state, "skipped");
  assert.equal(step.summary.reason, "fix ticket; runs for feat");
  assert.equal(step.summary.calls, 0, "nothing ran, so there is nothing to roll up");
  assert.equal(step.summary.seconds, undefined, "and no duration: its one line is its end");
});

test("a second run event appends a second root", () => {
  const tree = script(
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [2, { kind: "run", completed: [], steps: [{ name: "preflight", done: false }, { name: "review", done: false }] }],
    [3, { kind: "step", name: "review", at: 2, of: 2, state: "start" }],
  );

  assert.deepEqual(
    tree.roots.map((root) => root.children.map((step) => `${step.name}:${step.state}`)),
    [
      ["spec:already-done", "implement:running", "review:pending"],
      ["preflight:pending", "review:running"],
    ],
    "a sweep over many pull requests is this tree with more roots; nothing here emits a second one yet",
  );
  assert.equal(new Set(tree.roots.flatMap((root) => root.children.map((step) => step.key))).size, 5, "keys stay unique across roots");
});
