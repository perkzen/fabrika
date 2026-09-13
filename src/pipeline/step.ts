import { Effect, Exit } from "effect";
import type { FabrikaError } from "../errors.ts";
import type { AgentError } from "../ports/agent.ts";
import { Agent } from "../ports/agent.ts";
import { Captures } from "../ports/captures.ts";
import { Forge } from "../ports/forge.ts";
import { Gate } from "../ports/gate.ts";
import { Journal } from "../ports/journal.ts";
import { Prompts } from "../ports/prompts.ts";
import { Reviewer } from "../ports/reviewer.ts";
import { RunContext } from "../ports/run-context.ts";
import { RunStore } from "../ports/run-store.ts";
import { Workspace } from "../ports/workspace.ts";
import type { Escalated } from "./escalated.ts";

/** Everything a step may reach for. All of it is a port, so all of it is replaceable. */
export type StepServices =
  | Agent
  | Captures
  | Forge
  | Gate
  | Journal
  | Prompts
  | Reviewer
  | RunContext
  | RunStore
  | Workspace;

export type StepError = Escalated | FabrikaError | AgentError;

/**
 * One named piece of a run.
 *
 * A step is an effect, not a function of the previous step's output: what
 * travels between steps is the workspace, the artifacts in it and the run's
 * state — all of it durable, which is what makes a resumed run indis-
 * tinguishable from one that never died. A step that needed the step before
 * it to hand it something in memory would be a step that cannot resume.
 */
export type Step = {
  readonly name: string;
  /**
   * What a screen calls the step. `name` is identity — the completed list,
   * `replace`, the config — and is what every plain line prints; the title is
   * only ever read. Absent, the name stands in.
   */
  readonly title?: string;
  /** What the step will do, in a few dim words on its row until it has done it. */
  readonly about?: string;
  /**
   * What the step does, and — for the one step that decides the run is over —
   * the result line it came to. The driver logs that line after the last
   * step's `end`, because the piped contract is that the PR URL is the last
   * stdout line of a clean run: a step logging it itself would put it above
   * its own end. Every other step returns nothing and is untouched.
   */
  readonly run: Effect.Effect<string | void, StepError, StepServices>;
  /**
   * A reason to skip this run's step, or `undefined` to run it. A skipped
   * step is not recorded as completed: the reason is re-evaluated next time,
   * so a run resumed under a different verdict does the right thing.
   */
  readonly skip?: Effect.Effect<string | undefined, StepError, StepServices>;
  /**
   * Record the step in the run's `completed` list and skip it on a resume.
   * For steps that are not naturally idempotent — a stage costs a cold start
   * and a full gate run, so it is not repeated once it has passed.
   */
  readonly once?: boolean;
};

export type Pipeline = {
  readonly steps: ReadonlyArray<Step>;
  readonly run: Effect.Effect<void, StepError, StepServices>;
};

/**
 * Assembles a run out of steps.
 *
 * The order of a run, and which steps are in it, is data — so a repo that
 * wants its own step between `implement` and the PR, or a different reviewer
 * loop entirely, changes this list rather than the driver. Each call returns
 * a new builder; nothing is mutated in place.
 */
export type PipelineBuilder = {
  readonly step: (step: Step) => PipelineBuilder;
  readonly steps: (steps: Iterable<Step>) => PipelineBuilder;
  /** Swaps the step of that name, keeping its position. Unknown names are an error worth failing on early. */
  readonly replace: (name: string, step: Step) => PipelineBuilder;
  readonly without: (name: string) => PipelineBuilder;
  readonly build: () => Pipeline;
};

/**
 * Runs the steps and says how the run went.
 *
 * The result line is the driver's on both paths — it already owned the
 * escalated one — so there is one rule rather than two, and on both paths the
 * order is `step … end` then `result`.
 */
const drive = (steps: ReadonlyArray<Step>): Effect.Effect<void, StepError, StepServices> =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const journal = yield* Journal;
    const result = yield* body(steps, store, journal).pipe(
      // Every `new Escalated` in the repo leaves through here, so this is the
      // one place the reason has to be written down; it is re-raised so
      // cli.ts still owns the stderr block and the exit code.
      Effect.catchTag("Escalated", (error) =>
        journal
          .log({ kind: "result", outcome: "escalated", text: `escalated: ${error.reason}` })
          .pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
    // A pipeline built without the review step has no result line, which is
    // what it has always had.
    if (result !== undefined) yield* journal.log({ kind: "result", outcome: "done", text: result });
  });

const body = (
  steps: ReadonlyArray<Step>,
  store: RunStore,
  journal: Journal,
): Effect.Effect<string | undefined, StepError, StepServices> =>
  Effect.gen(function* () {
    const done = store.get().completed;
    // `done` is decided per index, never by name: a pipeline has two steps
    // called `review` and only the `once` one is finished by a resume.
    yield* journal.log({
      kind: "run",
      // Copied: `done` is the live array that `state.completed.push` mutates,
      // and an event has to say what was true when it was emitted.
      completed: [...done],
      steps: steps.map((step) => ({
        name: step.name,
        done: Boolean(step.once && done.includes(step.name)),
        ...(step.title === undefined ? {} : { title: step.title }),
        ...(step.about === undefined ? {} : { about: step.about }),
      })),
    });
    const of = steps.length;
    let result: string | undefined;
    for (const [index, step] of steps.entries()) {
      const at = index + 1;
      if (step.once && store.get().completed.includes(step.name)) {
        yield* journal.log({ kind: "step", name: step.name, ...titled(step), at, of, state: "already-done" });
        continue;
      }
      const skip = step.skip ? yield* step.skip : undefined;
      if (skip) {
        yield* journal.log({ kind: "step", name: step.name, ...titled(step), at, of, state: "skipped", reason: skip });
        continue;
      }
      yield* journal.log({ kind: "step", name: step.name, ...titled(step), at, of, state: "start" });
      const said = yield* timed(step, at, of, journal);
      if (typeof said === "string") result = said;
      if (step.once) yield* store.update((state) => void state.completed.push(step.name));
    }
    return result;
  });

/** The title, on the events a step emits, only when the step has one: an event says no more than it knows. */
const titled = (step: Step): { readonly title?: string } => (step.title === undefined ? {} : { title: step.title });

/**
 * One step, run and timed, with its `end` emitted on every exit — success,
 * failure and interruption alike — so a run that escalates never leaves a
 * step stuck at running.
 *
 * Suspended, because the clock has to be read when the step runs rather than
 * where the effect was built: a step run twice is timed twice.
 */
const timed = (
  step: Step,
  at: number,
  of: number,
  journal: Journal,
): Effect.Effect<string | void, StepError, StepServices> =>
  Effect.suspend(() => {
    const started = Date.now();
    return step.run.pipe(
      Effect.onExit((exit) =>
        journal.log({
          kind: "step",
          name: step.name,
          ...titled(step),
          at,
          of,
          state: "end",
          seconds: (Date.now() - started) / 1000,
          outcome: Exit.isSuccess(exit) ? "done" : "failed",
        }),
      ),
    );
  });

export const pipeline = (steps: ReadonlyArray<Step> = []): PipelineBuilder => ({
  step: (step) => pipeline([...steps, step]),
  steps: (more) => pipeline([...steps, ...more]),
  replace: (name, step) => {
    const at = steps.findIndex((s) => s.name === name);
    if (at < 0) throw new Error(`no step named ${name} to replace`);
    return pipeline(steps.map((s, i) => (i === at ? step : s)));
  },
  without: (name) => pipeline(steps.filter((s) => s.name !== name)),
  build: () => ({ steps, run: drive(steps) }),
});
