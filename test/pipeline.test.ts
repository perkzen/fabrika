import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { Escalated } from "../src/pipeline/escalated.ts";
import { pipeline, type Step } from "../src/pipeline/step.ts";
import { RunStore } from "../src/ports/run-store.ts";
import type { RunEvent } from "../src/run-event.ts";
import { exercise } from "./harness.ts";

const noop = (name: string, extra: Partial<Step> = {}): Step => ({
  name,
  run: Effect.gen(function* () {
    const store = yield* RunStore;
    yield* store.update((state) => void (state.sessions[name] = "ran"));
  }),
  ...extra,
});

test("runs its steps in order", async () => {
  const { recording } = await exercise(pipeline().step(noop("one")).step(noop("two")).build().run);
  assert.deepEqual(Object.keys(recording.state().sessions), ["one", "two"]);
});

test("a once step is recorded, and skipped when the run resumes", async () => {
  const built = pipeline().step(noop("spec", { once: true })).step(noop("plan", { once: true })).build();

  const first = await exercise(built.run);
  assert.deepEqual(first.recording.state().completed, ["spec", "plan"]);

  const resumed = await exercise(built.run, { state: { completed: ["spec"] } });
  assert.deepEqual(Object.keys(resumed.recording.state().sessions), ["plan"], "only the unfinished step runs again");
  assert.ok(resumed.recording.log.some((line) => line.includes("resuming after spec")));
});

test("a skipped step is not recorded as completed, so its reason is reconsidered next run", async () => {
  const step = noop("refactor", { once: true, skip: Effect.succeed("fix ticket") });
  const { recording } = await exercise(pipeline().step(step).build().run);
  assert.deepEqual(recording.state().completed, []);
  assert.deepEqual(recording.state().sessions, {});
  assert.ok(recording.log.some((line) => line === "refactor: skipped (fix ticket)"));
});

test("replace swaps a step but keeps its place", () => {
  const built = pipeline()
    .step(noop("one"))
    .step(noop("two"))
    .step(noop("three"))
    .replace("two", noop("swapped"))
    .build();
  assert.deepEqual(built.steps.map((step) => step.name), ["one", "swapped", "three"]);
});

test("without drops a step", () => {
  const built = pipeline().step(noop("one")).step(noop("two")).without("one").build();
  assert.deepEqual(built.steps.map((step) => step.name), ["two"]);
});

test("an escalated run records the reason before it fails", async () => {
  const escalating: Step = {
    name: "review",
    run: Effect.fail(new Escalated({ reason: "gate still red after 3 iterations", worktree: "/worktree" })),
  };
  const { failed, recording } = await exercise(pipeline().step(escalating).build().run);
  assert.equal(failed, true);
  assert.ok(recording.log.some((line) => line === "escalated: gate still red after 3 iterations"));
});

test("a resumed run shows the step list with the finished steps already done", async () => {
  const built = pipeline()
    .step(noop("spec", { once: true }))
    .step(noop("review", { once: true }))
    .step(noop("review"))
    .build();
  const { recording } = await exercise(built.run, { state: { completed: ["spec", "review"] } });

  assert.deepEqual(recording.log.slice(0, 2), ["resuming after spec, review", "steps: spec, review, review"]);
  const run = recording.events.find((entry): entry is Extract<RunEvent, { kind: "run" }> =>
    typeof entry !== "string" && entry.kind === "run",
  );
  assert.deepEqual(
    run?.steps,
    [
      { name: "spec", done: true },
      { name: "review", done: true },
      { name: "review", done: false },
    ],
    "done is decided per index, so the review loop is not marked done by the review stage",
  );
});

test("a fresh run names its steps but has nothing to resume after", async () => {
  const { recording } = await exercise(pipeline().step(noop("one")).step(noop("two")).build().run);
  assert.equal(recording.log[0], "steps: one, two");
});
