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
            // `cp -r` over the whole directory, not a `copyFile` per entry: an
            // agent is free to write a subdirectory of its own beside the
            // stage files, and `copyFile` refuses a directory source. Copying
            // is overwriting, so a retried archive is the later snapshot
            // rather than a merge of two.
            yield* fs.copy(from, target, { overwrite: true });
            return target;
          }).pipe(Effect.mapError(asFabrikaError(`copying ${from}`))),
        update: (change: (state: RunState) => void) => Effect.suspend(() => (change(state), save)),
      } satisfies RunStore;
    }),
  );
