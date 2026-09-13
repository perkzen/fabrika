import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { openScreen } from "../src/infra/screen.ts";
import type { RunEvent } from "../src/run-event.ts";

const noon = () => new Date(2026, 0, 1, 12, 0, 0).getTime();

/** A terminal the presenter can own: it writes, it has a size, and it emits the events a terminal emits. */
const terminal = (options: { columns?: number; rows?: number } = {}) => {
  const chunks: Array<string> = [];
  const stream = Object.assign(new EventEmitter(), {
    write: (chunk: string) => void chunks.push(chunk),
    isTTY: true,
    columns: options.columns ?? 80,
    rows: options.rows ?? 24,
  });
  return { stream: stream as unknown as NodeJS.WriteStream, chunks, text: () => chunks.join("") };
};

/** A keyboard the same way one stream over: raw mode is recorded rather than taken. */
const keyboard = () => {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    raw: [] as Array<boolean>,
    setRawMode(mode: boolean) {
      input.raw.push(mode);
      return input;
    },
    resume: () => input,
    pause: () => input,
    setEncoding: () => input,
    unref: () => input,
  });
  return input;
};

const open = (out: ReturnType<typeof terminal>, extra: { input?: ReturnType<typeof keyboard> } = {}) =>
  openScreen({
    stream: out.stream,
    interactive: true,
    now: noon,
    ticket: "FAB-6",
    input: (extra.input ?? keyboard()) as unknown as NodeJS.ReadStream,
    kill: () => {},
  });

const RUN: RunEvent = {
  kind: "run",
  completed: [],
  steps: [{ name: "preflight", done: false }, { name: "implement", done: false }, { name: "review", done: false }],
};

const RESULT: RunEvent = {
  kind: "result",
  outcome: "done",
  text: "done: checks green — ready for human review: https://github.com/perkzen/fabrika/pull/7",
};

test("the screen is entered by the run event and left by end(), which writes the outline and the result last", () => {
  const out = terminal({ columns: 80, rows: 12 });
  const presenter = open(out);

  presenter.show({ kind: "note", level: "info", text: "the branch is perkzen/feat/FAB-6" });
  assert.doesNotMatch(out.text(), /\x1b\[\?1049h/, "nothing before the run event enters the alternate buffer");
  assert.ok(out.text().includes("the branch is perkzen/feat/FAB-6"), "it is plain scrollback, written by the inner console");

  presenter.show(RUN);
  assert.match(out.text(), /\x1b\[\?1049h/, "the run event is what mounts the screen");
  assert.ok(out.text().indexOf("\x1b[?25l") > out.text().indexOf("\x1b[?1049h"), "the cursor is hidden on the buffer it is hidden in");

  presenter.show({ kind: "step", name: "implement", at: 2, of: 3, state: "start" });
  presenter.show(RESULT);
  const mounted = out.text();
  assert.doesNotMatch(mounted.split("\x1b[?1049h")[1]!, /ready for human review/, "the result is held, never streamed");

  presenter.end();
  const left = out.text().slice(out.text().lastIndexOf("\x1b[?1049l"));
  assert.ok(left.startsWith("\x1b[?1049l\x1b[?25h"), "the buffer is left and the cursor restored before anything is written to scrollback");
  assert.deepEqual(
    left.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd().split("\n"),
    [
      "· 1/3 preflight",
      "▸ 2/3 implement",
      "· 3/3 review",
      "done: checks green — ready for human review: https://github.com/perkzen/fabrika/pull/7",
    ],
    "the folded outline, then the result, last",
  );
});

test("a screen that never mounted leaves no buffer and writes no outline", () => {
  const out = terminal();
  const presenter = open(out);

  // The `already done: …` short-circuit: a run that stops before the pipeline
  // starts emits no `run` event, so there is nothing to enter and nothing to leave.
  presenter.show("already done: FAB-6 — remove ~/.fabrika/runs/fabrika/FAB-6 to rerun");
  presenter.end();

  assert.doesNotMatch(out.text(), /\x1b\[\?1049/, "no buffer was entered, so none is left");
  assert.equal(
    out.text().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd(),
    "12:00:00 already done: FAB-6 — remove ~/.fabrika/runs/fabrika/FAB-6 to rerun",
    "the inner console's line and nothing after it",
  );
});
