import assert from "node:assert/strict";
import { test } from "node:test";
import { frame, type View } from "../src/infra/frame.ts";
import { outline, type Tree } from "../src/outline.ts";
import type { RunEvent } from "../src/run-event.ts";

const noon = new Date(2026, 0, 1, 12, 0, 0).getTime();

/** The identity styler: a test asserts on the text, never on the escape codes around it. */
const bare = (_style: unknown, text: string) => text;

const script = (label: string, ...events: ReadonlyArray<readonly [number, RunEvent | string]>): Tree => ({
  ...outline(events.map(([seconds, entry]) => ({ at: noon + seconds * 1000, entry }))),
  label,
});

const view: View = { selected: "0:2", opened: null, chosen: false, scroll: 0, top: 0 };

const RUN: RunEvent = {
  kind: "run",
  completed: [],
  steps: [{ name: "preflight", done: false }, { name: "implement", done: false }, { name: "review", done: false }],
};

test("a frame is exactly rows lines, each at most columns - 1 wide", () => {
  const tree = script("FAB-6", [0, RUN], [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }]);
  const lines = frame(tree, view, { columns: 40, rows: 10 }, bare, { now: noon + 1000, spin: 0 });

  assert.equal(lines.length, 10, "the cursor arithmetic is only trivial while one line is one row");
  for (const line of lines) assert.ok(line.length <= 39, `"${line}" is wider than columns - 1`);
  assert.deepEqual(lines.slice(0, 4), [
    "FAB-6 [████░░░░░░░░] 2/3 implement",
    "· 1/3 preflight",
    "▸ 2/3 implement",
    "· 3/3 review",
  ]);
  assert.deepEqual(lines.slice(4), Array<string>(6).fill(""), "the rest of the viewport is blank, not stale");
});

test("a row too wide for the terminal is cut rather than wrapped", () => {
  const tree = script("FAB-6", [0, RUN]);
  const lines = frame(tree, view, { columns: 12, rows: 4 }, bare, { now: noon, spin: 0 });
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.slice(1), ["· 1/3 prefl", "· 2/3 imple", "· 3/3 revie"]);
});

const FINISHED: ReadonlyArray<readonly [number, RunEvent | string]> = [
  [0, RUN],
  [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
  [2, { kind: "tool", stage: "implement", tool: "Skill", subject: "fabrika:tdd" }],
  [3, { kind: "tool", stage: "implement", tool: "Bash", subject: "pnpm test" }],
  [4, { kind: "tool", stage: "implement", tool: "Bash", subject: "git commit" }],
  [5, { kind: "tool", stage: "implement", tool: "Edit", subject: "src/cli.ts" }],
  [6, { kind: "cost", stage: "implement", usd: 0.25 }],
  [7, { kind: "cost", stage: "implement", usd: 0.5 }],
  [8, { kind: "gate", name: "compile", at: 1, of: 2, command: "tsc", state: "pass", seconds: 3 }],
  [9, { kind: "gate", name: "test", at: 2, of: 2, command: "pnpm test", state: "fail", seconds: 41, exitCode: 1 }],
  [533, { kind: "step", name: "implement", at: 2, of: 3, state: "end", seconds: 533, outcome: "done" }],
];

test("a finished step's line carries its summary in field order", () => {
  const tree = script("FAB-6", ...FINISHED);
  const lines = frame(tree, view, { columns: 200, rows: 5 }, bare, { now: noon, spin: 0 });

  assert.equal(
    lines[2],
    "✔ 2/3 implement  8m 53s  $0.75  4 calls (Bash 2, Edit 1, Skill 1)  fabrika:tdd  gate: compile ok 3s, test FAILED 41s",
  );
});

test("a summary naming more than three tools says how many it left out", () => {
  const many = ["Bash", "Bash", "Bash", "Edit", "Edit", "Read", "Glob", "Grep"].map(
    (tool, index) => [index + 2, { kind: "tool", stage: "implement", tool, subject: "x" }] as const,
  );
  const tree = script(
    "FAB-6",
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    ...many,
    [20, { kind: "step", name: "implement", at: 2, of: 3, state: "end", seconds: 12, outcome: "failed" }],
  );
  const lines = frame(tree, view, { columns: 200, rows: 5 }, bare, { now: noon, spin: 0 });

  assert.equal(lines[2], "✖ 2/3 implement  12s  8 calls (Bash 3, Edit 2, Glob 1, +2 more)");
});

test("a skipped step carries its reason instead of a summary", () => {
  const tree = script(
    "FAB-6",
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "skipped", reason: "fix ticket; runs for feat" }],
  );
  const lines = frame(tree, view, { columns: 200, rows: 5 }, bare, { now: noon, spin: 0 });
  assert.equal(lines[2], "– 2/3 implement  skipped (fix ticket; runs for feat)");
});

test("a summary is truncated from the right, so the marker, position, name and state survive", () => {
  const tree = script("FAB-6", ...FINISHED);
  const lines = frame(tree, view, { columns: 30, rows: 5 }, bare, { now: noon, spin: 0 });

  assert.equal(lines[2], "✔ 2/3 implement  8m 53s  $0.7", "cut at columns - 1, the marker and the name intact");
});

test("a failed gate stays bold red inside the summary, and the rest of the row is not", () => {
  const tree = script("FAB-6", ...FINISHED);
  const dressed: Array<[unknown, string]> = [];
  frame(tree, view, { columns: 200, rows: 5 }, (style, text) => {
    dressed.push([style, text]);
    return text;
  }, { now: noon, spin: 0 });

  assert.ok(
    dressed.some(([style, text]) => text === "test FAILED 41s" && JSON.stringify(style) === '["bold","red"]'),
    "the one line the operator does read is the one that is wrong",
  );
  assert.ok(
    dressed.every(([, text]) => text !== "compile ok 3s"),
    "a gate that passed is dressed by nothing, so it recedes behind the one that did not",
  );
});
