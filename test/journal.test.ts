import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fileJournal from "../src/adapters/file-journal.ts";
import { Journal } from "../src/ports/journal.ts";

const noon = () => new Date(2026, 0, 1, 12, 0, 0).getTime();

test("the archive keeps an agent message raw while the console walks it", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "fabrika-journal-")), "log.txt");
  const chunks: Array<string> = [];
  const stream = { write: (chunk: string) => void chunks.push(chunk), on: () => stream, isTTY: false } as unknown as NodeJS.WriteStream;

  await Effect.runPromise(
    Effect.flatMap(Journal, (journal) =>
      journal.log({ kind: "agent", stage: "plan", markdown: "## Slices\n\n- one\n- two" }),
    ).pipe(Effect.provide(fileJournal.layer(file, { stream, interactive: false, now: noon }))),
  );

  assert.deepEqual(readFileSync(file, "utf8").trimEnd().split("\n"), [
    "12:00:00 ## Slices",
    "12:00:00 ",
    "12:00:00 - one",
    "12:00:00 - two",
  ], "raw markdown, stamped per physical line, so a pasted run renders on GitHub");
  assert.ok(chunks.join("").includes("• one"), "the console gets the walked form");
});
