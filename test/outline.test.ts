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
