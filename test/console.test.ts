import assert from "node:assert/strict";
import { test } from "node:test";
import { openConsole } from "../src/infra/console.ts";
import type { RunEvent } from "../src/run-event.ts";

/** Local noon on a fixed day: the stamp is `toLocaleTimeString`, so the clock must be local, not UTC. */
const noon = () => new Date(2026, 0, 1, 12, 0, 0).getTime();

/** A stream the presenter can own: it writes, it has a width, and it takes an error listener. */
const sink = (options: { isTTY?: boolean; columns?: number } = {}) => {
  const chunks: Array<string> = [];
  const stream = {
    write: (chunk: string) => void chunks.push(chunk),
    on: () => stream,
    isTTY: options.isTTY ?? false,
    columns: options.columns,
  };
  return {
    stream: stream as unknown as NodeJS.WriteStream,
    /** Mutable, so a test can resize the terminal between draws. */
    resize: (columns: number) => void (stream.columns = columns),
    chunks,
    text: () => chunks.join(""),
  };
};

/** What the operator actually sees: the escape codes stripped back out. */
const visible = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** One of each kind, in the order a run produces them. */
const scripted = (presenter: { show: (event: RunEvent) => void }) => {
  presenter.show({ kind: "run", completed: ["spec"], steps: [{ name: "spec", done: true }, { name: "implement", done: false }] });
  presenter.show({ kind: "step", name: "implement", at: 2, of: 2, state: "start" });
  presenter.show({ kind: "gate", name: "compile", at: 1, of: 1, command: "tsc", state: "start" });
  presenter.show({ kind: "gate", name: "compile", at: 1, of: 1, command: "tsc", state: "pass", seconds: 4 });
  presenter.show({ kind: "note", level: "warn", text: "the reviewer never answered" });
  presenter.show({ kind: "result", outcome: "done", text: "done: ready for human review" });
};

test("a step event reaches a plain sink as the line it replaces, stamped and nothing else", () => {
  const out = sink();
  const presenter = openConsole({ stream: out.stream, interactive: false, now: noon });
  presenter.show({ kind: "step", name: "refactor", at: 1, of: 1, state: "skipped", reason: "fix ticket" });
  presenter.end();
  assert.equal(out.text(), "12:00:00 refactor: skipped (fix ticket)\n");
});

test("a result event's text is written unchanged, and end() adds nothing after it", () => {
  const out = sink();
  const presenter = openConsole({ stream: out.stream, interactive: false, now: noon });
  presenter.show({
    kind: "result",
    outcome: "done",
    text: "done: cubic 5/5, no open threads, checks green — ready for human review: https://github.com/perkzen/fabrika/pull/7",
  });
  presenter.end();
  assert.equal(
    out.text(),
    "12:00:00 done: cubic 5/5, no open threads, checks green — ready for human review: https://github.com/perkzen/fabrika/pull/7\n",
  );
});

test("a plain console emits no escape bytes at all", () => {
  const out = sink();
  const presenter = openConsole({ stream: out.stream, interactive: false, now: noon });
  scripted(presenter);
  presenter.end();
  assert.doesNotMatch(out.text(), /\x1b/, "a piped run is fully plain, never partly dressed");
});

test("an interactive console dresses the same sequence", () => {
  const out = sink({ isTTY: true, columns: 120 });
  const presenter = openConsole({ stream: out.stream, interactive: true, now: noon });
  scripted(presenter);
  presenter.end();
  assert.match(out.text(), /\x1b/);
  assert.ok(
    out.text().includes(`\x1b[1m\x1b[32mdone: ready for human review\x1b[39m\x1b[22m`),
    "the terminal result is bold green",
  );
  assert.ok(out.text().includes(`\x1b[33mthe reviewer never answered\x1b[39m`), "a warning is yellow");
  assert.ok(out.text().includes(`\x1b[2m12:00:00\x1b[22m`), "the timestamp is dim everywhere");
});

test("NO_COLOR, TERM=dumb and CI each veto a TTY, and the verdict is one verdict", () => {
  const saved = { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM, CI: process.env.CI };
  const dressed = () => {
    const out = sink({ isTTY: true, columns: 120 });
    const presenter = openConsole({ stream: out.stream, now: noon });
    presenter.show({ kind: "step", name: "spec", at: 1, of: 2, state: "start" });
    presenter.end();
    return /\x1b/.test(out.text());
  };
  try {
    for (const veto of [{ NO_COLOR: "1" }, { TERM: "dumb" }, { CI: "true" }] as const) {
      delete process.env.NO_COLOR;
      delete process.env.CI;
      process.env.TERM = "xterm-256color";
      Object.assign(process.env, veto);
      assert.equal(dressed(), false, `${JSON.stringify(veto)} forces a plain console even on a TTY`);
    }
    delete process.env.NO_COLOR;
    delete process.env.CI;
    process.env.TERM = "xterm-256color";
    assert.equal(dressed(), true, "a bare TTY is dressed");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a permanent line lands between a clear of the live region and its redraw", () => {
  const out = sink({ isTTY: true, columns: 120 });
  const presenter = openConsole({ stream: out.stream, interactive: true, now: noon });
  presenter.show({ kind: "run", completed: [], steps: [{ name: "spec", done: false }, { name: "plan", done: false }] });
  presenter.show({ kind: "step", name: "spec", at: 1, of: 2, state: "start" });

  const before = out.text().length;
  presenter.show({ kind: "note", level: "info", text: "the branch is perkzen/feat/FAB-1" });
  const added = out.text().slice(before);

  assert.ok(added.startsWith("\x1b[1A\x1b[0J"), "the one live line is cleared before anything permanent is written");
  const note = added.indexOf("the branch is perkzen/feat/FAB-1");
  const redraw = added.indexOf("1/2 spec");
  assert.ok(note > 0 && redraw > note, "the live region is redrawn below the new permanent line");
});

test("a live line longer than the terminal is cut, and a resize is picked up on the next draw", () => {
  const out = sink({ isTTY: true, columns: 24 });
  const presenter = openConsole({ stream: out.stream, interactive: true, now: noon });
  presenter.show({ kind: "step", name: "implement", at: 4, of: 12, state: "start" });
  assert.equal(visible(out.chunks.at(-1)!), "[███░░░░░░░░░] 4/12 imp\n", "cut to columns - 1, never wrapped");

  out.resize(40);
  presenter.show({ kind: "step", name: "implement", at: 4, of: 12, state: "start" });
  assert.equal(visible(out.chunks.at(-1)!), "[███░░░░░░░░░] 4/12 implement\n", "width is read per draw, so no resize listener");
});

test("gate progress joins the live region and leaves it when the gate is over", () => {
  const out = sink({ isTTY: true, columns: 120 });
  const presenter = openConsole({ stream: out.stream, interactive: true, now: noon });
  presenter.show({ kind: "step", name: "implement", at: 1, of: 1, state: "start" });
  presenter.show({ kind: "gate", name: "compile", at: 1, of: 2, command: "tsc", state: "start" });
  assert.equal(visible(out.chunks.at(-1)!).split("\n")[1], "gate 1/2 compile");

  presenter.show({ kind: "gate", name: "lint", at: 2, of: 2, command: "eslint", state: "pass", seconds: 1 });
  assert.equal(visible(out.chunks.at(-1)!).split("\n").length, 2, "the last step passed, so the gate line is gone");
});
