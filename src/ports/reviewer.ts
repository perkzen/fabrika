import { Context, type Effect } from "effect";
import type { FabrikaError } from "../errors.ts";

export type ReviewThread = {
  readonly id: string;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
};

/** One review of one commit: a score out of five, and the threads still open. */
export type Review = {
  readonly commit: string;
  readonly score: number | null;
  readonly threads: ReadonlyArray<ReviewThread>;
};

/** What the agent decided about one thread. */
export type Decision = { readonly threadId: string; readonly action: "fixed" | "disputed"; readonly reply: string };

/**
 * The automated reviewer the run waits on. One provider is configured per
 * repo; the review loop is written against this, not against any one of them.
 *
 * `await` blocks until the provider has reviewed one of the commits pushed
 * this round, and returns `undefined` at the timeout — polling, the bot's
 * identity, how a score is encoded in a comment body and which threads count
 * as open all live behind it.
 *
 * `owns` is how the run tells the reviewer's own status check apart from the
 * repo's CI, so the review loop does not wait on the signal it is producing.
 */
export interface Reviewer {
  readonly name: string;
  readonly await: (
    pr: number,
    commits: ReadonlyArray<string>,
    timeoutMinutes: number,
  ) => Effect.Effect<Review | undefined, FabrikaError>;
  readonly reply: (threadId: string, body: string) => Effect.Effect<void, FabrikaError>;
  readonly resolve: (threadId: string) => Effect.Effect<void, FabrikaError>;
  readonly owns: (checkName: string, checkUrl: string) => boolean;
  /** The threads as the agent reads them, and the schema its answer must match. */
  readonly renderThreads: (threads: ReadonlyArray<ReviewThread>) => string;
  readonly decisionSchema: string;
}

export const Reviewer = Context.Service<Reviewer>("Reviewer");
