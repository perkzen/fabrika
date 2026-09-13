import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { rehearse } from "../scripts/rehearse.ts";

/** A non-TTY sink: the rehearsal gets the plain console, and the lines are the ones an operator would pipe. */
const sink = () => {
  const chunks: Array<string> = [];
  const stream = { write: (chunk: string) => (chunks.push(chunk), true), on: () => stream, isTTY: false, columns: 120 };
  return { stream: stream as unknown as NodeJS.WriteStream, text: () => chunks.join("") };
};

test("a rehearsal runs the whole pipeline to done on ports that touch nothing", async () => {
  const out = sink();
  const dir = mkdtempSync(join(tmpdir(), "fabrika-rehearsal-test-"));
  await Effect.runPromise(rehearse({ stream: out.stream, speed: 0, dir }));

  const lines = out.text().trimEnd().split("\n");
  assert.match(lines.at(-1)!, /^\d\d:\d\d:\d\d done: cubic 5\/5, no open threads, checks green — ready for human review: https:\/\/github\.com\/perkzen\/fabrika\/pull\/7$/, "the piped contract holds: the PR URL is the last line");
  assert.equal(lines.filter((line) => /step 1\/11: preflight/.test(line)).length, 1, "the run fabrika ships, all eleven steps of it, on one screen: the journal is built once");
  assert.equal(lines.filter((line) => /waiting for spec agent/.test(line)).length, 1, "and the agent's lines reach that same screen, not a second one");
  assert.ok(lines.some((line) => /refactor: skipped \(fix ticket; runs for feat\)/.test(line)), "the branch call says fix, so the feat-only stage is skipped");
  assert.ok(lines.some((line) => /gate test: FAILED/.test(line)) && lines.some((line) => /stage implement \(2\/4\)/.test(line)), "the gate goes red once and the stage retries");
  assert.ok(lines.some((line) => /waiting for cubic review/.test(line)), "the waits a real run has are waits here too");
  assert.ok(readFileSync(join(dir, "log.txt"), "utf8").includes("done: cubic 5/5"), "and the archive is the real one");
});
