import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fileJournal from "../src/adapters/file-journal.ts";
import { Journal } from "../src/ports/journal.ts";

const noon = () => new Date(2026, 0, 1, 12, 0, 0).getTime();

test("one event reaches both surfaces, each rendering it its own way", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "fabrika-journal-")), "log.txt");
  const chunks: Array<string> = [];
  const stream = { write: (chunk: string) => void chunks.push(chunk), on: () => stream, isTTY: false } as unknown as NodeJS.WriteStream;

  await Effect.runPromise(
    Effect.flatMap(Journal, (journal) =>
      journal.log({ kind: "agent", stage: "plan", markdown: "## Slices\n\n- one\n- two" }),
    ).pipe(Effect.provide(fileJournal.layer({ archive: file, stream, interactive: false, now: noon }))),
  );

  // What each surface does with the event is its own test; this is the fan-out.
  assert.match(readFileSync(file, "utf8"), /12:00:00 - one/, "the archive got it");
  assert.ok(chunks.join("").includes("• one"), "and the console got the same event, walked");
});

test("the layer finaliser closes every surface, exactly once", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "fabrika-journal-")), "log.txt");
  const chunks: Array<string> = [];
  const stream = {
    write: (chunk: string) => void chunks.push(chunk),
    on: () => stream,
    isTTY: true,
    columns: 80,
  } as unknown as NodeJS.WriteStream;

  await Effect.runPromise(
    Effect.flatMap(Journal, (journal) => journal.log({ kind: "step", name: "spec", at: 1, of: 2, state: "start" })).pipe(
      Effect.provide(fileJournal.layer({ archive: file, ticket: "FAB-1", stream, interactive: true, now: noon })),
    ),
  );

  assert.equal(chunks.join("").split("\x1b[?25h").length - 1, 1, "the console presenter is ended once, not once per surface");
});

/**
 * The environment `isInteractive` consults, put out of the way: whether a run
 * is watched is the stream's to say here, and a suite run under `CI=true` (or
 * `NO_COLOR`, or a dumb `TERM`) must not be able to answer for it.
 */
const bare = async <A>(run: () => Promise<A>): Promise<A> => {
  const saved = { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM, CI: process.env.CI };
  delete process.env.NO_COLOR;
  delete process.env.CI;
  process.env.TERM = "xterm-256color";
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/**
 * The verdict this test pins used to be made in `run.ts` and made again in
 * `scripts/rehearse.ts`, where no test could reach it — a rehearsal drives a
 * sink, and a sink is never interactive.
 */
test("a run an operator is watching gets the screen, and a piped one gets the scrolling log", () =>
  bare(async () => {
    const surface = (isTTY: boolean) => {
      const chunks: Array<string> = [];
      const stream = {
        write: (chunk: string) => void chunks.push(chunk),
        on: () => stream,
        off: () => stream,
        isTTY,
        columns: 80,
        rows: 24,
      } as unknown as NodeJS.WriteStream;
      return { stream, text: () => chunks.join("") };
    };
    const run = { kind: "run", completed: [], steps: [{ name: "spec", done: false }] } as const;
    const entered = async (isTTY: boolean) => {
      const file = join(mkdtempSync(join(tmpdir(), "fabrika-journal-")), "log.txt");
      const { stream, text } = surface(isTTY);
      await Effect.runPromise(
        Effect.flatMap(Journal, (journal) => journal.log(run)).pipe(
          Effect.provide(fileJournal.layer({ archive: file, ticket: "FAB-1", worktree: "/worktrees/FAB-1", stream, now: noon })),
        ),
      );
      // The alternate buffer: the one thing a screen does that a console never does.
      return { alternate: text().includes("\x1b[?1049h"), archived: readFileSync(file, "utf8") };
    };

    const watched = await entered(true);
    assert.ok(watched.alternate, "a terminal gets the screen");
    const piped = await entered(false);
    assert.ok(!piped.alternate, "and a pipe gets the scrolling log, whatever the run is");
    // Both, on either surface: the archive is not the console's to decide.
    for (const { archived } of [watched, piped]) assert.match(archived, /steps: spec/);
  }));

test("an archive-only journal writes the file and never touches the terminal", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "fabrika-journal-")), "log.txt");
  const wrote: Array<string> = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => (wrote.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    await Effect.runPromise(
      Effect.flatMap(Journal, (journal) => journal.log("base moved: 2 commit(s) behind; merging")).pipe(
        Effect.provide(fileJournal.archiveOnly(file)),
      ),
    );
  } finally {
    process.stdout.write = real;
  }

  assert.match(readFileSync(file, "utf8"), /base moved: 2 commit\(s\) behind; merging/, "the archive still gets everything");
  assert.ok(
    !wrote.join("").includes("base moved"),
    "and nothing reached stdout — six workers each opening a console would fight over it",
  );
});
