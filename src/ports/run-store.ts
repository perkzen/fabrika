import { Context, type Effect } from "effect";
import type { FabrikaError } from "../errors.ts";
import type { TicketType } from "../ticket.ts";

/**
 * Persisted after every step so a dead run resumes rather than restarts.
 *
 * The field names are the on-disk format: a state file written by an older
 * fabrika has to keep resuming, so they are added to, never renamed.
 */
export type RunState = {
  /** One Claude session per unit of work, by key: the stage, the merge, the review round. */
  sessions: Record<string, string>;
  /** Chosen once by the naming call; a resume must land on the same branch. */
  branch: string | null;
  /** The naming call's verdict, kept so a resumed run skips the same stages. */
  type: TicketType | null;
  completed: Array<string>;
  prNumber: number | null;
  round: number;
  pushed: Array<string>;
  /** Actions run ids already rerun once for a suspected flake. */
  reran: Array<string>;
  done: boolean;
};

/**
 * The run's memory. Two calls: read the current state, or change it — a
 * change is persisted before the effect completes, so no caller has to
 * remember to save and no step can leave the file behind its own progress.
 *
 * Loading, the migration of older files, the serialisation and the location
 * all sit behind that; `directory` is exposed because the raw agent logs and
 * the kept artifacts live beside the state file.
 */
export interface RunStore {
  /** `~/.fabrika/runs/<repo>/<ticket>` — the run's own directory. */
  readonly directory: string;
  readonly get: () => RunState;
  /**
   * Copies a directory's files into the run's own directory, so the stage
   * artifacts a human reads next to the PR outlive the worktree. Answers the
   * destination, or `undefined` when there was nothing to copy.
   */
  readonly archive: (directory: string) => Effect.Effect<string | undefined, FabrikaError>;
  readonly update: (change: (state: RunState) => void) => Effect.Effect<void, FabrikaError>;
}

export const RunStore = Context.Service<RunStore>("RunStore");
