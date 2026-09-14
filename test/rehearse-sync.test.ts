import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { rehearseSweep } from "../scripts/rehearse-sync.ts";

/** A non-TTY sink: the rehearsal gets the plain console, and the lines are the ones an operator would pipe. */
const sink = () => {
  const chunks: Array<string> = [];
  const stream = { write: (chunk: string) => (chunks.push(chunk), true), on: () => stream, isTTY: false, columns: 120 };
  return { stream: stream as unknown as NodeJS.WriteStream, text: () => chunks.join("") };
};

test("a sweep rehearsal runs the real fan-out over ports that touch nothing", async () => {
  const out = sink();
  const dir = mkdtempSync(join(tmpdir(), "fabrika-sweep-rehearsal-test-"));
  const result = await Effect.runPromise(rehearseSweep({ stream: out.stream, speed: 0, dir }));

  const lines = out.text().trimEnd().split("\n");
  assert.equal(
    lines.at(-1)?.slice("00:00:00 ".length),
    "sync: 2 synced, 1 already clean, 1 escalated, 0 failed, 2 skipped",
    "one of every row a sweep can draw, and the counts last — the line a scheduled invocation reads",
  );
  assert.equal(result.exitCode, 2, "an escalation is something a human has to come back to");
  assert.ok(
    lines.some((line) => /steps: FAB-5-42, FAB-7-41, pr-40, FAB-9-39, pr-38, FAB-3-37/.test(line)),
    "the rows are the pull requests it considered, skipped ones included, in list order",
  );
  assert.ok(
    lines.some((line) => /FAB-3-37: skipped \(branch is checked out at/.test(line)),
    "and a rule-skipped row is settled as a step, not only as a console line",
  );

  // The whole point of the rows: each worker's stream is its own, and the
  // archive it was mirrored from is still the durable copy of it.
  const log = (key: string) => readFileSync(join(dir, `${key}.log.txt`), "utf8");
  assert.match(log("FAB-5-42"), /2 conflicted file\(s\); resolving/);
  assert.match(log("FAB-5-42"), /the fan-out gained a `run` event/, "the agent's own words, as markdown, the way the archive keeps them");
  assert.doesNotMatch(log("FAB-5-42"), /src\/terminal\/frame\.ts/, "and nothing of the worker that could not finish");
  assert.match(log("FAB-9-39"), /src\/terminal\/frame\.ts/);
  assert.match(log("pr-38"), /worktree /, "a worker whose base had not moved still says where it worked");
});
