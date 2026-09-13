import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { CONFIG_TEMPLATE } from "../src/config.ts";
import { Escalated } from "../src/pipeline/escalated.ts";
import { choices, PULL_REQUEST, unknown } from "../src/domain/choices.ts";
import { fabrikaPipeline } from "../src/pipeline/fabrika.ts";
import { pipeline, type Step } from "../src/pipeline/step.ts";
import { RunStore } from "../src/ports/run-store.ts";
import type { RunEvent } from "../src/domain/run-event.ts";
import { exercise, type Recording } from "./harness.ts";

const noop = (name: string, extra: Partial<Step> = {}): Step => ({
  name,
  run: Effect.gen(function* () {
    const store = yield* RunStore;
    yield* store.update((state) => void (state.sessions[name] = "ran"));
  }),
  ...extra,
});

/** Which steps ended, and how they went. */
const ends = (recording: Recording) =>
  recording.events
    .filter(
      (entry): entry is Extract<RunEvent, { kind: "step" }> =>
        typeof entry !== "string" && entry.kind === "step" && entry.state === "end",
    )
    .map((entry) => [entry.name, entry.outcome]);

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

test("every step gets an end line, on the clean path and the escalated one", async () => {
  const clean = await exercise(pipeline().step(noop("one")).step(noop("two")).build().run);
  assert.deepEqual(ends(clean.recording), [["one", "done"], ["two", "done"]]);
  assert.ok(
    clean.recording.log.some((line) => /^step one: done \(\d+s\)$/.test(line)),
    "and it reads as a line, in the flat log and in log.txt",
  );

  const escalating: Step = {
    name: "review",
    run: Effect.fail(new Escalated({ reason: "gate still red after 3 iterations", worktree: "/worktree" })),
  };
  const escalated = await exercise(pipeline().step(noop("one")).step(escalating).build().run);
  assert.deepEqual(
    ends(escalated.recording),
    [["one", "done"], ["review", "failed"]],
    "a run that escalates never leaves a step stuck at running",
  );
  assert.deepEqual(
    escalated.recording.log.slice(-2),
    ["step review: failed (0s)", "escalated: gate still red after 3 iterations"],
    "and the escalated path ends the same way the clean one does: the step's end, then the result",
  );
});

test("a skipped or already-done step gets no end, their one line being their end", async () => {
  const built = pipeline()
    .step(noop("spec", { once: true }))
    .step(noop("refactor", { once: true, skip: Effect.succeed("fix ticket") }))
    .build();
  const { recording } = await exercise(built.run, { state: { completed: ["spec"] } });
  assert.deepEqual(ends(recording), [], "neither step ran, so neither has a duration or an outcome");
});

test("the result is the driver's, and lands after the last step's end", async () => {
  const finishing: Step = {
    name: "review",
    run: Effect.succeed("done: checks green — ready for human review: https://github.com/perkzen/fabrika/pull/7"),
  };
  const { recording } = await exercise(pipeline().step(noop("one")).step(finishing).build().run);

  const tail = recording.log.slice(-2);
  assert.match(tail[0]!, /^step review: done \(\d+s\)$/);
  assert.equal(
    tail[1],
    "done: checks green — ready for human review: https://github.com/perkzen/fabrika/pull/7",
    "the PR URL is the last stdout line of a clean run, after the last step's end",
  );
});

test("a run no step returned a line for logs no result", async () => {
  const { recording } = await exercise(pipeline().step(noop("one")).build().run);
  assert.ok(
    !recording.events.some((entry) => typeof entry !== "string" && entry.kind === "result"),
    "which is what a pipeline built without the review step has always done",
  );
});

test("a step's title and what it will do travel on the run event and its step lines, and its name stays its name", async () => {
  const built = pipeline()
    .step({ ...noop("spec"), title: "Spec", about: "agent" })
    .step(noop("review"))
    .build();
  const { recording } = await exercise(built.run);

  const run = recording.events.find((entry): entry is Extract<RunEvent, { kind: "run" }> =>
    typeof entry !== "string" && entry.kind === "run",
  );
  assert.deepEqual(run?.steps, [{ name: "spec", done: false, title: "Spec", about: "agent" }, { name: "review", done: false }]);
  const start = recording.events.find(
    (entry): entry is Extract<RunEvent, { kind: "step" }> => typeof entry !== "string" && entry.kind === "step" && entry.state === "start",
  );
  assert.equal(start?.title, "Spec", "the step's own lines carry it too, for the live region that reads them");
  assert.equal(recording.log[0], "steps: spec, review", "and no plain line says anything but the name");
});

/**
 * The run fabrika ships, and the one an operator asked for a part of.
 *
 * A step nobody chose is left out rather than skipped, so these read the
 * built pipeline's names: that list is what the `run` event announces and
 * what the outline draws, and it is the whole of what choosing changes.
 */
const names = (chosen?: ReadonlyArray<string>) => fabrikaPipeline(CONFIG_TEMPLATE, chosen).steps.map((step) => step.name);

test("no selection runs the whole pipeline, which is what a pipe and a schedule get", () => {
  assert.deepEqual(names(), [
    "preflight",
    "branch",
    "workspace",
    "spec",
    "plan",
    "implement",
    "refactor",
    "security",
    "review",
    "pull-request",
    "review",
  ]);
});

test("choosing keeps those stages, in the config's order rather than the order they were named in", () => {
  assert.deepEqual(names(["security", "implement"]), ["preflight", "branch", "workspace", "implement", "security"]);
});

test("the tree is never a choice: a run with nothing chosen still has somewhere to work", () => {
  assert.deepEqual(names([]), ["preflight", "branch", "workspace"]);
});

test("the review loop goes with the pull request, having no rounds without one", () => {
  assert.deepEqual(names(["implement"]), ["preflight", "branch", "workspace", "implement"]);
  assert.deepEqual(names(["implement", PULL_REQUEST]).slice(-2), ["pull-request", "review"]);
});

test("choosing the review stage does not drag in the review loop, though they share a name", () => {
  assert.deepEqual(names(["review"]), ["preflight", "branch", "workspace", "review"]);
});

test("the choices are the stages this repo configured, plus the pull request", () => {
  assert.deepEqual(
    choices(CONFIG_TEMPLATE).map((choice) => choice.name),
    ["spec", "plan", "implement", "refactor", "security", "review", PULL_REQUEST],
  );
  assert.equal(choices(CONFIG_TEMPLATE)[2]!.about, "agent · gate", "a choice says what the step will do");
});

test("a name that is nothing in this repo is named back, so a typo is not a stage silently not running", () => {
  assert.deepEqual(unknown(CONFIG_TEMPLATE, ["implement", "refacter", "pr"]), ["refacter", "pr"]);
  assert.deepEqual(unknown(CONFIG_TEMPLATE, ["implement", PULL_REQUEST]), []);
});
