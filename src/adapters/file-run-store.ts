import { Effect, FileSystem, Layer, Path } from "effect";
import { asFabrikaError } from "../errors.ts";
import { RunStore, type RunState } from "../ports/run-store.ts";

const EMPTY: RunState = {
  sessions: {},
  branch: null,
  type: null,
  completed: [],
  prNumber: null,
  round: 0,
  pushed: [],
  reran: [],
  done: false,
};

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
        ? { ...EMPTY, ...(JSON.parse(yield* fs.readFileString(file)) as Partial<RunState>) }
        : { ...EMPTY };
      const save = fs.writeFileString(file, JSON.stringify(state, null, 2)).pipe(Effect.mapError(asFabrikaError(`writing ${file}`)));
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
    }),
  );
