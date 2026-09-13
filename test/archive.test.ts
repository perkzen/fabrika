import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive } from "../src/terminal/archive.ts";

/** Local noon on a fixed day: the stamp is `toLocaleTimeString`, so the clock must be local, not UTC. */
const noon = () => new Date(2026, 0, 1, 12, 0, 0).getTime();

const logFile = () => join(mkdtempSync(join(tmpdir(), "fabrika-archive-")), "log.txt");
const lines = (file: string) => readFileSync(file, "utf8").trimEnd().split("\n");

test("every physical line is stamped, so a multi-line event stays greppable", () => {
  const file = logFile();
  const archive = openArchive({ file, now: noon });
  archive.show({ kind: "step", name: "implement", at: 3, of: 9, state: "start" });
  archive.show({ kind: "note", level: "info", text: "one\ntwo" });
  archive.end();

  assert.deepEqual(lines(file), ["12:00:00 step 3/9: implement", "12:00:00 one", "12:00:00 two"]);
});

test("the archive keeps agent speech as the markdown it was written in", () => {
  const file = logFile();
  const archive = openArchive({ file, now: noon });
  archive.show({ kind: "agent", stage: "plan", markdown: "## Slices\n\n- one\n- two" });
  archive.end();

  assert.deepEqual(
    lines(file),
    ["12:00:00 ## Slices", "12:00:00 ", "12:00:00 - one", "12:00:00 - two"],
    "`- item` renders where `• item` does not, and a run is pasted into issues",
  );
});

test("the archive is never dressed, whatever the terminal is doing", () => {
  const file = logFile();
  const archive = openArchive({ file, now: noon });
  archive.show({ kind: "result", outcome: "escalated", text: "escalated: gate still red" });
  archive.end();
  assert.doesNotMatch(readFileSync(file, "utf8"), /\x1b/);
});

test("a line that cannot be written is dropped rather than failing the run", () => {
  const archive = openArchive({ file: join(tmpdir(), "fabrika-no-such-dir", "log.txt"), now: noon });
  assert.doesNotThrow(() => archive.show("the console still has it"));
  assert.doesNotThrow(archive.end);
});

test("agent speech cannot carry escapes into the file either", () => {
  const file = logFile();
  const archive = openArchive({ file, now: noon });
  archive.show({ kind: "agent", stage: "plan", markdown: "## Slices\n\x1b]0;pwned\x07- one" });
  archive.end();
  assert.doesNotMatch(readFileSync(file, "utf8"), /[\x00-\x08\x0b-\x1f\x7f-\x9f]/, "the archive is the ANSI-free copy, whatever the agent said");
});
