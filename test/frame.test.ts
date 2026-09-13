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
