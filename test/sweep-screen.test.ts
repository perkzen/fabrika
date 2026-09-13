import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Effect } from "effect";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fileJournal from "../src/adapters/file-journal.ts";
import { Journal } from "../src/ports/journal.ts";
import { openScreen } from "../src/terminal/screen.ts";
import type { RunEvent } from "../src/domain/run-event.ts";

/**
 * What a sweep does to a terminal: the buffer it enters, the keys it answers,
 * the line it leaves last, and the two journal forms behind it. Driven by a
 * scripted event list against a fake terminal, the way `screen.test.ts` drives
 * a run's.
 *
 * What is *drawn* is asserted in `frame.test.ts`, against the pure frame: a
 * screen redraws on its own timer, so a test that read the viewport here would
 * be reading the frame it mounted with.
 */

const noon = () => new Date(2026, 0, 1, 12, 0, 0).getTime();

/** A terminal the presenter can own: it writes, it has a size, and it emits what a terminal emits. */
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

/** A keyboard, one stream over: raw mode is recorded rather than taken. */
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

/** The three pull requests a sweep selected, as the `run` event it emits for them. */
const SWEEP: RunEvent = {
  kind: "run",
  completed: [],
  steps: [
    { name: "FAB-5-42", title: "#42 FAB-5", about: "[yours] Conflicted PRs pile up — would sync branch-42 into origin/main", done: false },
    { name: "pr-41", title: "#41", about: "[fabrika] fix: second — would sync branch-41 into origin/main", done: false },
    { name: "FAB-9-40", title: "#40 FAB-9", about: "[yours] A third thing", done: false },
  ],
};

const start = (name: string, title: string, at: number): RunEvent => ({ kind: "step", name, title, at, of: 3, state: "start" });

const screenOf = (out: ReturnType<typeof terminal>, extra: { input?: ReturnType<typeof keyboard>; open?: (worktree: string) => void } = {}) =>
  openScreen({
    stream: out.stream,
    interactive: true,
    now: noon,
    ticket: "perkzen/fabrika",
    input: (extra.input ?? keyboard()) as unknown as NodeJS.ReadStream,
    kill: () => {},
    open: extra.open,
  });

test("a sweep enters the alternate buffer, and the counts line is the last thing it leaves", () => {
  const out = terminal({ columns: 80, rows: 12 });
  const screen = screenOf(out);

  screen.show(SWEEP);
  assert.match(out.text(), /\x1b\[\?1049h/, "the sweep's run event mounts the screen, the same as a run's");
  screen.show(start("FAB-5-42", "#42 FAB-5", 1));
  screen.show({ kind: "step", name: "FAB-5-42", title: "#42 FAB-5", at: 1, of: 3, state: "end", seconds: 12, outcome: "done" });
  screen.show({ kind: "result", outcome: "escalated", text: "sync: 1 synced, 0 already clean, 1 escalated, 0 failed, 1 skipped" });
  screen.end();

  const left = out.text().slice(out.text().lastIndexOf("\x1b[?1049l"));
  assert.deepEqual(
    left.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd().split("\n"),
    [
      " ✔ #42 FAB-5      12s",
      " ○ #41        [fabrika] fix: second — would sync branch-41 into origin/main",
      " ○ #40 FAB-9  [yours] A third thing",
      "sync: 1 synced, 0 already clean, 1 escalated, 0 failed, 1 skipped",
    ],
    "the outline, then the counts — the contract a scheduled invocation reads is last on the way out too",
  );
});

test("o opens the selected row's worktree, and a row with no tree offers none", () => {
  const out = terminal({ columns: 80, rows: 24 });
  const keys = keyboard();
  const opened: Array<string> = [];
  const screen = screenOf(out, { input: keys, open: (where) => void opened.push(where) });

  screen.show(SWEEP);
  screen.show(start("FAB-5-42", "#42 FAB-5", 1));
  screen.show(start("pr-41", "#41", 2));
  // The tree travels with the row, the way `Tree.worktree` travels with the
  // screen: the composition root knows it, no run event carries it.
  screen.row("FAB-5-42", "/worktrees/FAB-5-42");
  screen.row("pr-41");

  keys.emit("data", "o");
  assert.deepEqual(opened, ["/worktrees/FAB-5-42"], "the selected row's tree, not one path for the whole sweep");

  keys.emit("data", "\x1b[B");
  keys.emit("data", "o");
  assert.deepEqual(opened, ["/worktrees/FAB-5-42"], "a row whose worker never got a tree opens nothing");
});

test("^C interrupts the sweep rather than exiting, and the terminal is given back", () => {
  const out = terminal({ columns: 80, rows: 24 });
  const keys = keyboard();
  let interrupted = 0;
  const screen = openScreen({
    stream: out.stream,
    interactive: true,
    now: noon,
    ticket: "perkzen/fabrika",
    input: keys as unknown as NodeJS.ReadStream,
    kill: () => void (interrupted += 1),
  });

  screen.show(SWEEP);
  screen.show(start("FAB-5-42", "#42 FAB-5", 1));
  keys.emit("data", "\x03");
  assert.equal(interrupted, 1, "raw mode stops the terminal raising SIGINT, so the screen raises it");

  screen.end();
  const left = out.text().slice(out.text().lastIndexOf("\x1b[?1049l"));
  assert.ok(left.startsWith("\x1b[?1049l\x1b[?25h"), "the alternate buffer is left and the cursor shown");
  assert.deepEqual(keys.raw, [true, false], "raw mode holds the event loop open, so release is the exact inverse");
});

test("a worker's row mirrors its log.txt rather than replacing it", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "fabrika-sweep-")), "log.txt");
  const seen: Array<RunEvent | string> = [];
  const row = { show: (entry: RunEvent | string) => void seen.push(entry), end: () => {} };

  await Effect.runPromise(
    Effect.flatMap(Journal, (journal) => journal.log("worktree /worktrees/FAB-5-42")).pipe(
      Effect.provide(fileJournal.archiveOnly(file, [row])),
    ),
  );

  assert.match(readFileSync(file, "utf8"), /worktree \/worktrees\/FAB-5-42/, "the archive is still the durable record");
  assert.deepEqual(seen, ["worktree /worktrees/FAB-5-42"], "and the row got the same event, unchanged");
});

test("a piped sweep gets the scrollback console, and a row is silence", async () => {
  const chunks: Array<string> = [];
  const stream = { write: (chunk: string) => void chunks.push(chunk), on: () => stream, isTTY: false } as unknown as NodeJS.WriteStream;
  const surface = fileJournal.sweep({ label: "perkzen/fabrika", stream, interactive: false, now: noon });

  await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      yield* journal.log(SWEEP);
      // A row on a console sweep has no window to write into, and a worker's
      // detail stays in its own `log.txt`.
      surface.row("FAB-5-42", "/worktrees/FAB-5-42").show("worktree /worktrees/FAB-5-42");
      yield* journal.log({ kind: "result", outcome: "done", text: "sync: 1 synced, 0 already clean, 0 escalated, 0 failed, 0 skipped" });
    }).pipe(Effect.provide(surface.layer)),
  );

  const written = chunks.join("");
  assert.doesNotMatch(written, /\x1b\[\?1049h/, "no alternate buffer where nobody is watching");
  assert.ok(written.includes("steps: FAB-5-42, pr-41, FAB-9-40"), "the step lines a piped sweep now carries");
  assert.doesNotMatch(written, /worktree \/worktrees\/FAB-5-42/, "and nothing of the worker's, which is its archive's");
  assert.equal(
    written.trimEnd().split("\n").at(-1)?.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").slice("12:00:00 ".length),
    "sync: 1 synced, 0 already clean, 0 escalated, 0 failed, 0 skipped",
    "the counts are the last line on stdout, rendered as exactly the text they are",
  );
});
