import { Context, type Effect } from "effect";

/**
 * Where a run says what it is doing. One line at a time, already stamped and
 * already fanned out to wherever the operator reads it.
 *
 * `write` is the same line without the Effect wrapper: the agent's
 * stream-json callback is a plain function, and that is the only caller that
 * needs it.
 */
export interface Journal {
  readonly log: (line: string) => Effect.Effect<void>;
  readonly write: (line: string) => void;
}

export const Journal = Context.Service<Journal>("Journal");
