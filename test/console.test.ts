import assert from "node:assert/strict";
import { Writable } from "node:stream";
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

/** A clock the test winds by hand, so every elapsed time is a fact rather than a race. */
const clock = (from = noon()) => {
  let at = from;
  return { now: () => at, advance: (seconds: number) => void (at += seconds * 1000) };
};

test("an open wait animates in the live region and counts against its deadline", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const out = sink({ isTTY: true, columns: 120 });
  const time = clock();
  const presenter = openConsole({ stream: out.stream, interactive: true, now: time.now });

  presenter.show({ kind: "wait", state: "start", subject: "cubic-dev-ai review of abc1234", deadlineMinutes: 25 });
  time.advance(252);
  t.mock.timers.tick(80);
  const first = visible(out.chunks.at(-1)!);
  assert.ok(first.includes("waiting for cubic-dev-ai review of abc1234 — 4m 12s / 25m"), first);

  t.mock.timers.tick(80);
  const second = visible(out.chunks.at(-1)!);
  assert.notEqual(second[0], first[0], "the frame advances, which is what proves the run is alive");

  presenter.end();
});

test("a piped wait heartbeats once a minute and says how long it waited", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const out = sink();
  const time = clock();
  const presenter = openConsole({ stream: out.stream, interactive: false, now: time.now });

  presenter.show({ kind: "wait", state: "start", subject: "checks on abc1234", deadlineMinutes: 20 });
  t.mock.timers.tick(60_000);
  t.mock.timers.tick(60_000);
  time.advance(252);
  presenter.show({ kind: "wait", state: "end", subject: "checks on abc1234", seconds: 252 });
  presenter.end();

  assert.deepEqual(
    out.text().trimEnd().split("\n"),
    [
      "12:00:00 waiting for checks on abc1234",
      "12:00:00 waiting for checks on abc1234",
      "12:00:00 waiting for checks on abc1234",
      "12:04:12 waited 4m 12s for checks on abc1234",
    ],
    "the start line is byte-identical to the one the poll loop wrote per poll",
  );
});

test("end() leaves no timer armed, so a clean run can exit", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const out = sink();
  const presenter = openConsole({ stream: out.stream, interactive: false, now: noon });
  presenter.show({ kind: "wait", state: "start", subject: "implement agent" });
  presenter.end();

  const settled = out.text().length;
  t.mock.timers.tick(600_000);
  assert.equal(out.text().length, settled, "a leaked interval holds the event loop open forever");
});

test("a closed wait takes the live region's second line with it", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const out = sink({ isTTY: true, columns: 120 });
  const presenter = openConsole({ stream: out.stream, interactive: true, now: noon });
  presenter.show({ kind: "step", name: "implement", at: 1, of: 1, state: "start" });
  presenter.show({ kind: "wait", state: "start", subject: "implement agent" });
  assert.equal(visible(out.chunks.at(-1)!).split("\n").length, 3, "run progress and the wait");

  presenter.show({ kind: "wait", state: "end", subject: "implement agent", seconds: 9 });
  assert.equal(visible(out.chunks.at(-1)!).split("\n").length, 2, "run progress alone");
  presenter.end();
});

const NESTED = `## The plan

- outer with **bold**
  - inner one
  - inner two

3. third
4. fourth

\`\`\`ts
const x = 1;
\`\`\`

> a quote
`;

test("agent speech is walked as markdown, and the plain walk agrees on every line break", () => {
  const out = sink();
  const presenter = openConsole({ stream: out.stream, interactive: false, now: noon });
  presenter.show({ kind: "agent", stage: "plan", markdown: NESTED });
  presenter.end();

  assert.doesNotMatch(out.text(), /\x1b/);
  assert.deepEqual(
    out.text().trimEnd().split("\n").map((line) => line.replace("12:00:00 ", "")),
    [
      "│ ## The plan",
      "│ ",
      "│ • outer with bold",
      "│   • inner one",
      "│   • inner two",
      "│ ",
      "│ 3. third",
      "│ 4. fourth",
      "│ ",
      "│   ts",
      "│   const x = 1;",
      "│ ",
      "│ │ a quote",
    ],
    "the gutter marks the whole block as the agent talking; nesting and list numbering are the markdown's",
  );
});

test("an interactive walk styles the same lines it broke the same way", () => {
  const plainOut = sink();
  const dressedOut = sink({ isTTY: true, columns: 200 });
  for (const [out, interactive] of [[plainOut, false], [dressedOut, true]] as const) {
    const presenter = openConsole({ stream: out.stream, interactive, now: noon });
    presenter.show({ kind: "agent", stage: "plan", markdown: NESTED });
    presenter.end();
  }
  assert.equal(visible(dressedOut.text()), plainOut.text(), "the two surfaces differ in escape codes and nothing else");
  assert.ok(dressedOut.text().includes("\x1b[1mbold\x1b[22m"), "inline bold survives the walk");
});

test("one agent message cannot own the screen", () => {
  const out = sink();
  const presenter = openConsole({ stream: out.stream, interactive: false, now: noon, archive: "log.txt" });
  presenter.show({ kind: "agent", stage: "implement", markdown: Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") });
  presenter.end();

  const lines = out.text().trimEnd().split("\n").map((line) => line.replace("12:00:00 ", ""));
  assert.equal(lines.length, 21, "twenty rendered lines and the one that says what is missing");
  assert.equal(lines[19], "│ line 20");
  assert.equal(lines[20], "│ … 40 more lines (log.txt)");
});

test("a message that fits is printed whole, with nothing said about elision", () => {
  const out = sink();
  const presenter = openConsole({ stream: out.stream, interactive: false, now: noon, archive: "log.txt" });
  presenter.show({ kind: "agent", stage: "implement", markdown: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") });
  presenter.end();
  const lines = out.text().trimEnd().split("\n");
  assert.equal(lines.length, 12);
  assert.doesNotMatch(out.text(), /more lines/);
});

test("with no archive to point at, the elision line says less rather than naming a file that does not exist", () => {
  const out = sink();
  const presenter = openConsole({ stream: out.stream, interactive: false, now: noon });
  presenter.show({ kind: "agent", stage: "configure", markdown: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") });
  presenter.end();
  assert.ok(out.text().trimEnd().endsWith("│ … 10 more lines"));
});

test("a dead pipe does not kill the run", () => {
  const chunks: Array<string> = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  }) as unknown as NodeJS.WriteStream;
  const presenter = openConsole({ stream, interactive: false, now: noon });

  presenter.show("still here");
  // Without a listener this throws and takes the process with it; raw
  // stream.write does not swallow EPIPE the way console.log did.
  stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  presenter.show("and still here");
  presenter.end();

  assert.equal(chunks.length, 2);
});

test("end() is idempotent, so a second close cannot double-restore the terminal", () => {
  const out = sink({ isTTY: true, columns: 80 });
  const presenter = openConsole({ stream: out.stream, interactive: true, now: noon });
  presenter.show({ kind: "step", name: "spec", at: 1, of: 1, state: "start" });
  presenter.end();
  presenter.end();
  assert.equal(out.text().split("\x1b[?25h").length - 1, 1);
});

test("an interrupt restores the terminal, and end() takes the handler back off", () => {
  const before = process.listenerCount("SIGINT");
  const out = sink({ isTTY: true, columns: 80 });
  const presenter = openConsole({ stream: out.stream, interactive: true, now: noon });
  presenter.show({ kind: "step", name: "spec", at: 1, of: 1, state: "start" });
  assert.equal(process.listenerCount("SIGINT"), before + 1);

  // Not process.emit: runMain owns SIGINT too, and this handler must not
  // preempt the interruption that runs the layer finalisers.
  (process.listeners("SIGINT").at(-1) as () => void)();
  assert.ok(out.text().endsWith("\x1b[?25h"));
  assert.equal(process.listenerCount("SIGINT"), before, "and it takes itself off again");
  presenter.end();
});

test("a plain console installs no signal handler, having no terminal to restore", () => {
  const before = process.listenerCount("SIGINT");
  const presenter = openConsole({ stream: sink().stream, interactive: false, now: noon });
  assert.equal(process.listenerCount("SIGINT"), before);
  presenter.end();
});
