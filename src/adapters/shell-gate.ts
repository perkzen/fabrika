import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { matchesGlob } from "node:path";
import type { GateStep } from "../config.ts";
import { asFabrikaError } from "../errors.ts";
import { sh } from "../infra/shell.ts";
import { Gate, type GateFailure } from "../ports/gate.ts";
import { Journal } from "../ports/journal.ts";
import { Workspace } from "../ports/workspace.ts";

/** How much of a failing step's output an agent is handed. Tail, because that is where the error is. */
const TAIL = 6000;

/**
 * The repo's own checks, run by the host in the worktree: sequential,
 * deterministic, first failure wins. A step with `when` runs only when the
 * branch changed a file matching one of its globs.
 *
 * A gate step is the one place the deny list could be laundered back in —
 * the agent says what to run, the host runs it — which is why the steps come
 * from the committed config and never from a stage.
 */
export const layer = (steps: ReadonlyArray<GateStep>) =>
  Layer.effect(Gate)(
    Effect.gen(function* () {
      const workspace = yield* Workspace;
      const journal = yield* Journal;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      return {
        feedback: (failure: GateFailure) =>
          `The host-run gate failed at step "${failure.name}" (${failure.command}). Fix it, commit, and stop.\n\nOutput (tail):\n\n${failure.output}`,

        check: Effect.gen(function* () {
          const changed = yield* workspace.changedFiles;
          for (const step of steps) {
            if (step.when && !changed.some((file) => step.when!.some((glob) => matchesGlob(file, glob)))) {
              yield* journal.log(`gate ${step.name}: skipped (no matching changes)`);
              continue;
            }
            yield* journal.log(`gate ${step.name}: ${step.run}`);
            const started = Date.now();
            const { code, out } = yield* Effect.provideService(
              sh(workspace.dir, step.run),
              ChildProcessSpawner.ChildProcessSpawner,
              spawner,
            ).pipe(Effect.mapError(asFabrikaError(`gate ${step.name}`)));
            const seconds = ((Date.now() - started) / 1000).toFixed(0);
            if (code !== 0) {
              yield* journal.log(`gate ${step.name}: FAILED (exit ${code}, ${seconds}s)`);
              return { name: step.name, command: step.run, output: out.slice(-TAIL) } satisfies GateFailure;
            }
            yield* journal.log(`gate ${step.name}: ok (${seconds}s)`);
          }
          return undefined;
        }),
      } satisfies Gate;
    }),
  );
