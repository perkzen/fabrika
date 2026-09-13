import assert from "node:assert/strict";
import { test } from "node:test";
import { syncWithBase } from "../src/pipeline/sync.ts";
import type { MergeOutcome } from "../src/ports/workspace.ts";
import { exercise } from "./harness.ts";

const conflicted: MergeOutcome = { _tag: "Conflicted", behind: 2, files: ["src/a.ts"] };

test("a caller can name the session the merge is resolved in", async () => {
  const { failed, recording } = await exercise(syncWithBase({ session: "sync-9f1c2ab" }), { merge: [conflicted] });

  assert.equal(failed, false);
  assert.deepEqual(
    recording.agent.map((call) => call.session ?? call.stage),
    ["sync-9f1c2ab"],
    "a sweep names the session after the base tip, which no round counter can collide with",
  );
});

test("a caller that names none still lands in the round's own session", async () => {
  const { failed, recording } = await exercise(syncWithBase(), { merge: [conflicted], state: { round: 3 } });

  assert.equal(failed, false);
  assert.deepEqual(
    recording.agent.map((call) => call.session ?? call.stage),
    ["merge-3"],
    "the default is the old key, so both existing callers behave exactly as they did",
  );
});

/** The other place one session holds two calls; the same rule (ADR-0005). */
test("neither call of a base merge names a model", async () => {
  const { recording } = await exercise(syncWithBase(), {
    merge: [conflicted],
    gate: [{ name: "compile", command: "tsc", output: "boom" }, undefined],
  });
  assert.deepEqual(
    recording.agent.map((call) => call.stage),
    ["merge", "merge-gate"],
    "the resolve and the repair after it",
  );
  assert.deepEqual(recording.agent.map((call) => call.model), [undefined, undefined]);
});
