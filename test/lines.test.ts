import assert from "node:assert/strict";
import { test } from "node:test";
import { display, livenessRow, progressRow } from "../src/terminal/lines.ts";
import type { Style } from "../src/terminal/console.ts";
import type { RunEvent } from "../src/domain/run-event.ts";

/** The identity styler: a test asserts on the text, never on the escape codes around it. */
const bare = (_style: Style, text: string) => text;

/** The same, recording what each line was dressed with. */
const spy = () => {
  const calls: Array<[Style, string]> = [];
  return { calls, dress: (style: Style, text: string) => (calls.push([style, text]), text) };
};

const long = (lines: number): RunEvent => ({
  kind: "agent",
  stage: "implement",
  markdown: Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join("\n"),
});

test("an agent message is uncapped when no cap is given, and capped with an elision line when one is", () => {
  const whole = display(long(30), bare);
  assert.equal(whole.length, 30, "a window is scrolled rather than elided, so nothing in it is cut off");
  assert.equal(whole[0], "│ line 1");
  assert.equal(whole.at(-1), "│ line 30");

  const capped = display(long(30), bare, { cap: 20, archive: "log.txt" });
  assert.equal(capped.length, 21, "twenty rendered lines and the one that says what is missing");
  assert.equal(capped[19], "│ line 20");
  assert.equal(capped[20], "│ … 10 more lines (log.txt)");
});

test("a line is dressed by the colour of its kind", () => {
  const result = spy();
  display({ kind: "result", outcome: "done", text: "done: ready for human review" }, result.dress);
  assert.deepEqual(result.calls, [[["bold", "green"], "done: ready for human review"]]);

  const tool = spy();
  display({ kind: "tool", stage: "implement", tool: "Read", subject: "src/cli.ts" }, tool.dress);
  assert.deepEqual(tool.calls, [["dim", "  Read src/cli.ts"]], "the indent is the line's, the dim is the kind's");

  const note = spy();
  display("wrote .fabrika/config.json", note.dress);
  assert.deepEqual(note.calls, [], "a bare string is an info note, and an info note is the terminal's own colour");
});

/** Local noon on a fixed day, so an elapsed time is a fact the test states. */
const noon = new Date(2026, 0, 1, 12, 0, 0).getTime();

test("the run's progress reads the same on both surfaces, and says nothing about a step that has not started", () => {
  assert.equal(progressRow({ at: 2, of: 3, name: "implement" }), "[████░░░░░░░░] 2/3 implement");
  assert.equal(
    progressRow({ at: 0, of: 3, name: "" }),
    "[░░░░░░░░░░░░] 0/3",
    "the run has said what it is made of and started none of it",
  );
});

test("what the run is blocked on is one row, and a gate and a wait can never both claim it", () => {
  const wait = { subject: "cubic review of abc1234", since: noon, deadlineMinutes: 25 };
  assert.equal(
    livenessRow({ wait }, { now: noon + 252_000, spin: 0 }),
    "⠋ waiting for cubic review of abc1234 — 4m 12s / 25m",
  );
  assert.equal(
    livenessRow({ wait }, { now: noon + 252_000, spin: 1 })?.[0],
    "⠙",
    "the frame advances, which is what proves the run is alive",
  );
  assert.equal(
    livenessRow({ wait: { subject: "the implement agent", since: noon } }, { now: noon + 9000, spin: 0 }),
    "⠋ waiting for the implement agent — 9s",
    "nothing is counted against when nothing was promised",
  );

  const gate = { name: "compile", at: 1, of: 2, command: "npm run compile" };
  assert.equal(
    livenessRow({ gate }, { now: noon, spin: 0 }),
    "gate 1/2 compile",
    "the command is the window's own addition, not this row's",
  );
  assert.equal(livenessRow({}, { now: noon, spin: 0 }), undefined, "nothing is blocking the run");
});
