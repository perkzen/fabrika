import assert from "node:assert/strict";
import { test } from "node:test";
import type { View } from "../src/infra/frame.ts";
import { decode, follow, press } from "../src/infra/keys.ts";
import { outline, type Tree } from "../src/outline.ts";
import type { RunEvent } from "../src/run-event.ts";

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

/** A run with its second step running, and the view that follows it. */
const running = script(RUN, { kind: "step", name: "implement", at: 2, of: 3, state: "start" });
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
  assert.equal(press("down", bottom, running, size).selected, "0:3");
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

test("moving the selection past the bottom of the outline scrolls it", () => {
  const long = script({
    kind: "run",
    completed: [],
    steps: Array.from({ length: 11 }, (_, index) => ({ name: `step${index + 1}`, done: false })),
  });
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
