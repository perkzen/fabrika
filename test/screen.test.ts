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
  return {
    stream: stream as unknown as NodeJS.WriteStream,
    /** Mutable and announced, the way a terminal resizes. */
    resize: (columns: number, rows: number) => {
      stream.columns = columns;
      stream.rows = rows;
      stream.emit("resize");
    },
    fail: () => stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
    chunks,
    text: () => chunks.join(""),
  };
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

test("a frame is drawn on the timer while a wait is open, and not otherwise", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const out = terminal();
  const presenter = open(out);

  presenter.show(RUN);
  presenter.show({ kind: "step", name: "implement", at: 2, of: 3, state: "start" });
  t.mock.timers.tick(80);
  const settled = out.chunks.length;
  t.mock.timers.tick(160);
  assert.equal(out.chunks.length, settled, "a model nothing has changed is not redrawn twelve times a second");

  presenter.show({ kind: "wait", state: "start", subject: "implement agent" });
  t.mock.timers.tick(80);
  const spinning = out.chunks.length;
  t.mock.timers.tick(160);
  assert.equal(out.chunks.length, spinning + 2, "an open wait is what proves the run is alive, so it animates");

  presenter.show({ kind: "wait", state: "end", subject: "implement agent", seconds: 9 });
  t.mock.timers.tick(80);
  const closed = out.chunks.length;
  t.mock.timers.tick(160);
  assert.equal(out.chunks.length, closed, "and it stops when the wait does");

  presenter.end();
});

test("raw mode is taken on mount and released on every exit path", () => {
  const out = terminal();
  const keys = keyboard();
  const presenter = open(out, { input: keys });

  presenter.show({ kind: "note", level: "info", text: "the branch is perkzen/feat/FAB-6" });
  assert.deepEqual(keys.raw, [], "nothing is taken before there is a screen to take it for");

  presenter.show(RUN);
  assert.deepEqual(keys.raw, [true]);
  assert.equal(keys.listenerCount("data"), 1);

  presenter.end();
  assert.deepEqual(keys.raw, [true, false], "raw mode holds the event loop open, so release is the exact inverse");
  assert.equal(keys.listenerCount("data"), 0);
});

test("Ctrl-C raises SIGINT rather than exiting, so the MCP finalisers still run", () => {
  const out = terminal();
  const keys = keyboard();
  let raised = 0;
  const presenter = openScreen({
    stream: out.stream,
    interactive: true,
    now: noon,
    ticket: "FAB-6",
    input: keys as unknown as NodeJS.ReadStream,
    kill: () => void (raised += 1),
  });

  presenter.show(RUN);
  keys.emit("data", "\x03");
  assert.equal(raised, 1, "raw mode stops the terminal raising it, so the presenter does");
  presenter.end();
});

test("a key moves the view and nothing else, and the next frame shows it", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const out = terminal({ columns: 60, rows: 10 });
  const keys = keyboard();
  const presenter = open(out, { input: keys });

  presenter.show(RUN);
  presenter.show({ kind: "step", name: "implement", at: 2, of: 3, state: "start" });
  presenter.show({ kind: "tool", stage: "implement", tool: "Read", subject: "src/cli.ts" });
  t.mock.timers.tick(80);
  assert.match(out.chunks.at(-1)!, /Read src\/cli\.ts/, "the running step is unfolded by default");

  // Space on the step that is already open folds it, which is the only
  // visible effect a key may have.
  keys.emit("data", " ");
  t.mock.timers.tick(80);
  assert.doesNotMatch(out.chunks.at(-1)!, /Read src\/cli\.ts/);

  presenter.end();
});

test("a TTY stdout with a piped stdin gets the screen and no keys", () => {
  const out = terminal();
  const piped = Object.assign(new EventEmitter(), { isTTY: false });
  const presenter = openScreen({
    stream: out.stream,
    interactive: true,
    now: noon,
    ticket: "FAB-6",
    input: piped as unknown as NodeJS.ReadStream,
    kill: () => {},
  });

  presenter.show(RUN);
  assert.match(out.text(), /\x1b\[\?1049h/, "the interactivity verdict is about the output surface");
  assert.equal(piped.listenerCount("data"), 0, "and a run nobody can touch already has to end the same way");
  presenter.end();
});

test("a resize redraws at the new size, with no leftovers from the old one", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const out = terminal({ columns: 60, rows: 10 });
  const presenter = open(out);

  presenter.show(RUN);
  t.mock.timers.tick(80);
  assert.equal(out.chunks.at(-1)!.split("\n").length, 10, "one line per row, which is what the cursor arithmetic counts on");

  out.resize(40, 14);
  t.mock.timers.tick(80);
  assert.equal(out.chunks.at(-1)!.split("\n").length, 14, "the next frame is right at the new size");
  presenter.end();
});

test("a dead pipe does not kill the run, and end() gives the terminal and the signal back", () => {
  const before = process.listenerCount("SIGINT");
  const out = terminal();
  const presenter = open(out);

  presenter.show(RUN);
  assert.equal(process.listenerCount("SIGINT"), before + 1, "the inner console's handler was taken off as the screen took its own");

  out.fail();
  presenter.show({ kind: "step", name: "implement", at: 2, of: 3, state: "start" });
  presenter.end();

  assert.equal(process.listenerCount("SIGINT"), before, "and it takes itself off again");
  assert.match(out.text(), /\x1b\[\?25h/, "the cursor is restored on every exit path");
});

test("show after end is a no-op, so a late event cannot write over restored scrollback", () => {
  const out = terminal();
  const presenter = open(out);

  presenter.show(RUN);
  presenter.end();
  const settled = out.text();

  // `journal.log` inside the step driver's onExit runs during interruption,
  // after the synchronous SIGINT handler has already ended the screen.
  presenter.show({ kind: "step", name: "implement", at: 2, of: 3, state: "end", seconds: 9, outcome: "failed" });
  presenter.end();
  assert.equal(out.text(), settled);
});

test("the result line is scrubbed on the way to scrollback, so it cannot forge the line above it", () => {
  const out = terminal({ columns: 80, rows: 12 });
  const presenter = open(out);

  presenter.show(RUN);
  // The escalation wording carries `gh` output and agent text; an escape in it
  // reaches the terminal at the one moment the operator reads the outcome.
  presenter.show({
    kind: "result",
    outcome: "escalated",
    text: "escalated: \x1b[2Jcannot push\rdone: ready for human review: https://example.test/1",
  });
  presenter.end();

  const left = out.text().slice(out.text().lastIndexOf("\x1b[?1049l"));
  assert.ok(!left.includes("\x1b[2J"), "no escape of the agent's survives into the terminal");
  assert.ok(!left.includes("\r"), "and no carriage return, which would overwrite the line it is on");
  assert.equal(
    left.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd().split("\n").at(-1),
    "escalated: [2Jcannot pushdone: ready for human review: https://example.test/1",
    "the escape stays on screen as the defanged text it is",
  );
});
