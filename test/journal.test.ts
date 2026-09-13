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
    ).pipe(Effect.provide(fileJournal.layer(file, { stream, interactive: false, now: noon }))),
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
      Effect.provide(fileJournal.layer(file, { stream, interactive: true, now: noon })),
    ),
  );

  assert.equal(chunks.join("").split("\x1b[?25h").length - 1, 1, "the console presenter is ended once, not once per surface");
});
