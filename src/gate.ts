import { Effect } from "effect";
import { matchesGlob } from "node:path";
import type { GateStep } from "./config.ts";
import { sh } from "./shell.ts";

export type GateFailure = { readonly name: string; readonly command: string; readonly output: string };

const TAIL = 6000;

/**
 * Host-run, sequential, deterministic. Stops at the first failure and returns
 * it; `undefined` means green. Steps with `when` run only if a changed file
 * matches one of the globs.
 */
export const runGate = (
  dir: string,
  steps: ReadonlyArray<GateStep>,
  changed: ReadonlyArray<string>,
  log: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    for (const step of steps) {
      if (step.when && !changed.some((f) => step.when!.some((g) => matchesGlob(f, g)))) {
        yield* log(`gate ${step.name}: skipped (no matching changes)`);
        continue;
      }
      yield* log(`gate ${step.name}: ${step.run}`);
      const started = Date.now();
      const { code, out } = yield* sh(dir, step.run);
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      if (code !== 0) {
        yield* log(`gate ${step.name}: FAILED (exit ${code}, ${secs}s)`);
        return { name: step.name, command: step.run, output: out.slice(-TAIL) } satisfies GateFailure;
      }
      yield* log(`gate ${step.name}: ok (${secs}s)`);
    }
    return undefined;
  });
