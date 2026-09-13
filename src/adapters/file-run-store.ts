import { Effect, FileSystem, Layer, Path } from "effect";
import { asFabrikaError } from "../errors.ts";
import { RunStore, type RunState } from "../ports/run-store.ts";

/** A function, not a constant: spreading a shared literal would hand every state the same arrays. */
const empty = (): RunState => ({
  sessions: {},
  branch: null,
  type: null,
  completed: [],
  prNumber: null,
  round: 0,
  pushed: [],
  reran: [],
  done: false,
});

/**
 * A state file that is not JSON, as `null` rather than as a thrown exception:
 * `JSON.parse` inside an `Effect.map` is a defect, which no `orElse` catches
 * and which the sweep's per-pull-request isolation does not hold either — one
 * unreadable file would take the whole sweep down.
 */
const parsed = (raw: string): Partial<RunState> | null => {
  try {
    return JSON.parse(raw) as Partial<RunState>;
  } catch {
    return null;
  }
};

/**
 * The run directory whose state claims that pull request, if one exists.
 *
 * There is no index from a pull request to a run: `prNumber` lives inside each
 * state file, so finding one means reading them. It belongs here because this
 * is the module that writes that file and migrates it — a field renamed has
 * one place to look — and it is best-effort by design (ADR-0003): a run
 * directory is worth reusing for the session it holds, and a sweep that cannot
 * find one opens a fresh one under the pull request's own key.
 *
 * Sorted, so two runs claiming one pull request resolve the same way on every
 * machine rather than in `readdir` order.
 */
export const runDirectoryFor = (runs: string, prNumber: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(runs);
    for (const entry of entries.sort()) {
      const state = yield* fs
        .readFileString(path.join(runs, entry, "state.json"))
        .pipe(Effect.map(parsed), Effect.orElseSucceed(() => null));
      if (state?.prNumber === prNumber) return path.join(runs, entry);
    }
    return undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * `state.json` in the run's directory, read once at the start and written
 * again after every change.
 *
 * A file written by an older fabrika is missing whatever was added since, so
 * it is merged onto the empty state rather than trusted — the alternative is
 * a resume that dies on `undefined.push` in the middle of a review round.
 */
export const layer = (directory: string) =>
  Layer.effect(RunStore)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(directory, { recursive: true });
      const file = path.join(directory, "state.json");
      const state: RunState = (yield* fs.exists(file))
        ? { ...empty(), ...(JSON.parse(yield* fs.readFileString(file)) as Partial<RunState>) }
        : empty();
      // Suspended: the state is mutated in place, so serialising it when the
      // layer is built would write the same first snapshot forever.
      const save = Effect.suspend(() => fs.writeFileString(file, JSON.stringify(state, null, 2))).pipe(
        Effect.mapError(asFabrikaError(`writing ${file}`)),
      );
      return {
        directory,
        get: () => state,
        archive: (from: string) =>
          Effect.gen(function* () {
            if (!(yield* fs.exists(from))) return undefined;
            const target = path.join(directory, "work");
            yield* fs.makeDirectory(target, { recursive: true });
            for (const name of yield* fs.readDirectory(from)) {
              yield* fs.copyFile(path.join(from, name), path.join(target, name));
            }
            return target;
          }).pipe(Effect.mapError(asFabrikaError(`copying ${from}`))),
        update: (change: (state: RunState) => void) => Effect.suspend(() => (change(state), save)),
      } satisfies RunStore;
      // Building the store reads and creates directories, and a layer that
      // could not be built has to fail with the one error the ports speak —
      // otherwise a platform error escapes into every caller's error type.
    }).pipe(Effect.mapError(asFabrikaError(`opening ${directory}`))),
  );
