import assert from "node:assert/strict";
import { test } from "node:test";
import type { View } from "../src/terminal/frame.ts";
import { decode, follow, press } from "../src/terminal/keys.ts";
import { outline, type Tree } from "../src/domain/outline.ts";
import type { RunEvent } from "../src/domain/run-event.ts";

const noon = new Date(2026, 0, 1, 12, 0, 0).getTime();

const script = (...events: ReadonlyArray<RunEvent>): Tree =>
  outline(events.map((entry, index) => ({ when: noon + index * 1000, entry })));

const RUN: RunEvent = {
  kind: "run",
  completed: [],
  steps: [{ name: "preflight", done: false }, { name: "implement", done: false }, { name: "review", done: false }],
};

const size = { columns: 80, rows: 24 };
const fresh: View = { selected: "", opened: null, chosen: false, scroll: 0, top: 0 };

/** A run with its first step done and its second running, and the view that follows it. */
const running = script(
  RUN,
  { kind: "step", name: "preflight", at: 1, of: 3, state: "start" },
  { kind: "step", name: "preflight", at: 1, of: 3, state: "end", seconds: 1, outcome: "done" },
  { kind: "step", name: "implement", at: 2, of: 3, state: "start" },
);
const watching = follow(fresh, running);

/** The same run once the step has said more than its window can hold, which is what makes a page key mean anything. */
const talking = script(
  RUN,
  { kind: "step", name: "implement", at: 2, of: 3, state: "start" },
  ...Array.from({ length: 30 }, (_, index): RunEvent => ({ kind: "note", level: "info", text: `line ${index}` })),
);
const reading = follow(fresh, talking);

test("doing nothing follows the running step, selection and fold alike", () => {
  assert.deepEqual(watching, { selected: "0:2", opened: "0:2", chosen: false, scroll: 0, top: 0 });
});

test("arrows and k/j move the selection and stop it following", () => {
  assert.deepEqual(decode("\x1b[A"), ["up"]);
  assert.deepEqual(decode("\x1b[B"), ["down"]);
  assert.deepEqual(decode("kj"), ["up", "down"]);

  const up = press("up", watching, running, size);
  assert.equal(up.selected, "0:1");
  assert.equal(up.chosen, true);
  assert.equal(up.opened, "0:2", "moving the selection does not move the fold");
  assert.equal(follow(up, running).selected, "0:1", "and the operator is in charge until they say otherwise");

  assert.equal(press("up", up, running, size).selected, "0:1", "the ends of the outline are the ends");
  const bottom = press("down", press("down", up, running, size), running, size);
  assert.equal(bottom.selected, "0:2", "a step that has not run has nothing to unfold, so the selection cannot land on it");
});

test("the selection steps over steps that never ran, and enters from the end it moves away from", () => {
  const resumed = script(
    { kind: "run", completed: ["preflight"], steps: [{ name: "preflight", done: true }, { name: "implement", done: false }, { name: "refactor", done: false }, { name: "review", done: false }] },
    { kind: "step", name: "preflight", at: 1, of: 4, state: "already-done" },
    { kind: "step", name: "implement", at: 2, of: 4, state: "start" },
    { kind: "step", name: "implement", at: 2, of: 4, state: "end", seconds: 1, outcome: "done" },
    { kind: "step", name: "refactor", at: 3, of: 4, state: "skipped", reason: "fix ticket; runs for feat" },
    { kind: "step", name: "review", at: 4, of: 4, state: "start" },
  );
  const view = follow(fresh, resumed);
  assert.equal(view.selected, "0:4");

  const up = press("up", view, resumed, size);
  assert.equal(up.selected, "0:2", "the skipped step between them is stepped over: there is nothing under its line");
  assert.equal(press("up", up, resumed, size).selected, "0:2", "and the already-done step above is the end of what can be read");
  assert.equal(press("down", up, resumed, size).selected, "0:4");

  assert.equal(press("down", fresh, resumed, size).selected, "0:2", "nothing selected yet, a move down starts at the first readable step");
  assert.equal(press("up", fresh, resumed, size).selected, "0:4", "and a move up at the last");
});

test("toggle opens one step and closes whatever was open", () => {
  assert.deepEqual(decode(" "), ["toggle"]);
  assert.deepEqual(decode("\r"), ["toggle"]);

  const moved = press("up", watching, running, size);
  const opened = press("toggle", moved, running, size);
  assert.equal(opened.opened, "0:1", "a view where six steps sit open because nobody closed them cannot happen");

  const closed = press("toggle", opened, running, size);
  assert.equal(closed.opened, null);
  assert.equal(closed.selected, "0:1", "closing a step does not move off it");
});

test("page-up stops the tail-follow, and page-down back to zero resumes it", () => {
  assert.deepEqual(decode("\x1b[5~"), ["page-up"]);
  assert.deepEqual(decode("\x1b[6~"), ["page-down"]);

  const back = press("page-up", reading, talking, size);
  assert.ok(back.scroll > 0, "following is scroll === 0, not a second flag that can disagree with it");

  const forward = press("page-down", back, talking, size);
  assert.equal(forward.scroll, 0);
  assert.equal(press("page-down", forward, talking, size).scroll, 0, "and never past the tail");
});

test("Esc goes back to following the running step", () => {
  assert.deepEqual(decode("\x1b"), ["follow"]);

  const wandered = press("page-up", press("toggle", press("up", watching, running, size), running, size), running, size);
  assert.deepEqual(press("follow", wandered, running, size), watching, "doing nothing is always the right thing");
});

test("a step folds itself when it ends, unless the operator unfolded it by hand", () => {
  const later = script(
    RUN,
    { kind: "step", name: "implement", at: 2, of: 3, state: "start" },
    { kind: "step", name: "implement", at: 2, of: 3, state: "end", seconds: 9, outcome: "done" },
    { kind: "step", name: "review", at: 3, of: 3, state: "start" },
  );
  assert.equal(follow(watching, later).opened, "0:3", "the default view stays the outline plus the step running now");

  const chosen = press("toggle", press("up", watching, running, size), running, size);
  assert.equal(follow(chosen, later).opened, "0:1", "until they press Esc, what they chose stays open");
});

test("an interrupt is not the view's business, and an unknown byte changes nothing", () => {
  assert.deepEqual(decode("\x03"), ["interrupt"]);
  assert.deepEqual(decode("q"), ["unknown"]);
  assert.deepEqual(press("interrupt", watching, running, size), watching);
  assert.deepEqual(press("unknown", watching, running, size), watching);
});

test("o is a key, and opening an editor is no more a view change than an interrupt is", () => {
  assert.deepEqual(decode("o"), ["open"]);
  assert.deepEqual(press("open", watching, running, size), watching, "keys change nothing about the run");
});

test("moving the selection past the bottom of the outline scrolls it", () => {
  // Every step has run, so every row can be landed on.
  const long = script(
    {
      kind: "run",
      completed: [],
      steps: Array.from({ length: 11 }, (_, index) => ({ name: `step${index + 1}`, done: false })),
    },
    ...Array.from({ length: 11 }, (_, index): ReadonlyArray<RunEvent> => [
      { kind: "step", name: `step${index + 1}`, at: index + 1, of: 11, state: "start" },
      { kind: "step", name: `step${index + 1}`, at: index + 1, of: 11, state: "end", seconds: 1, outcome: "done" },
    ]).flat(),
  );
  const small = { columns: 60, rows: 8 };

  let moving = { ...fresh, selected: "0:1", top: 0 };
  for (let press_ = 0; press_ < 10; press_ += 1) moving = press("down", moving, long, small);

  assert.equal(moving.selected, "0:11");
  assert.equal(moving.top, 4, "the key handler owns top, so the outline does not jump a row at a time under the reader");
});

test("page-up stops at the top of the stream, so one page-down always comes back to the tail", () => {
  const once = press("page-up", reading, talking, size);
  const twice = press("page-up", once, talking, size);
  assert.ok(once.scroll > 0, "there is more above the window than it can show");
  assert.equal(twice.scroll, once.scroll, "and nothing above the first line, so the view stays where the reader put it");
  assert.equal(press("page-down", twice, talking, size).scroll, 0, "coming back is one press, not as many as were spent");

  assert.equal(press("page-up", watching, running, size).scroll, 0, "a window holding less than it can show has nothing to scroll at all");
});

/**
 * A sweep has several rows running at once, which a run never has, so
 * "unfold the running step" has to name one of them. The first in list order
 * is the rule: it is stable while the others start and finish under it, where
 * "the most recently started" would move the window on every worker handed
 * out.
 */
const sweeping = script(
  { kind: "run", completed: [], steps: [{ name: "a", done: false }, { name: "b", done: false }, { name: "c", done: false }] },
  { kind: "step", name: "a", at: 1, of: 3, state: "start" },
  { kind: "step", name: "b", at: 2, of: 3, state: "start" },
  { kind: "step", name: "c", at: 3, of: 3, state: "start" },
);

test("with several rows running, following unfolds the first of them and stays there", () => {
  assert.deepEqual(follow(fresh, sweeping), { selected: "0:1", opened: "0:1", chosen: false, scroll: 0, top: 0 });

  const later = outline([
    ...[
      { kind: "run", completed: [], steps: [{ name: "a", done: false }, { name: "b", done: false }, { name: "c", done: false }] },
      { kind: "step", name: "a", at: 1, of: 3, state: "start" },
      { kind: "step", name: "b", at: 2, of: 3, state: "start" },
      { kind: "step", name: "c", at: 3, of: 3, state: "start" },
      { kind: "step", name: "b", at: 2, of: 3, state: "end", seconds: 1, outcome: "done" },
    ].map((entry, index) => ({ when: noon + index * 1000, entry: entry as RunEvent })),
  ]);
  assert.equal(follow(follow(fresh, sweeping), later).opened, "0:1", "a sibling finishing does not move the window");

  const first = outline([
    ...[
      { kind: "run", completed: [], steps: [{ name: "a", done: false }, { name: "b", done: false }, { name: "c", done: false }] },
      { kind: "step", name: "a", at: 1, of: 3, state: "start" },
      { kind: "step", name: "b", at: 2, of: 3, state: "start" },
      { kind: "step", name: "a", at: 1, of: 3, state: "end", seconds: 1, outcome: "done" },
    ].map((entry, index) => ({ when: noon + index * 1000, entry: entry as RunEvent })),
  ]);
  assert.equal(follow(follow(fresh, sweeping), first).opened, "0:2", "and when it is the open row that finishes, the next running one takes it");
});

test("a skipped row is not one the selection can land on", () => {
  const withSkip = script(
    { kind: "run", completed: [], steps: [{ name: "a", done: false }, { name: "b", done: false }, { name: "c", done: false }] },
    { kind: "step", name: "b", at: 2, of: 3, state: "skipped", reason: "usage limit hit — not started" },
    { kind: "step", name: "a", at: 1, of: 3, state: "start" },
    { kind: "step", name: "c", at: 3, of: 3, state: "start" },
  );

  assert.equal(press("down", follow(fresh, withSkip), withSkip, size).selected, "0:3", "the skipped row in the middle is stepped over");
});
