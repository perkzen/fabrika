import assert from "node:assert/strict";
import { test } from "node:test";
import { display } from "../src/infra/lines.ts";
import type { Style } from "../src/infra/console.ts";
import type { RunEvent } from "../src/run-event.ts";

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
