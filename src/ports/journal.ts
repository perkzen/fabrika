import { Context, type Effect } from "effect";
import type { RunEvent } from "../run-event.ts";

/**
 * Where a run says what it is doing. It carries run events, not pre-formatted
 * strings, and fans each one out to every surface that reports the run. A
 * bare string is sugar for an info note.
 *
 * `write` is the same entry without the Effect wrapper: the agent's
 * stream-json callback is a plain function, and that is the only caller that
 * needs it. It has to stay synchronous.
 */
export interface Journal {
  readonly log: (entry: RunEvent | string) => Effect.Effect<void>;
  readonly write: (entry: RunEvent | string) => void;
}

export const Journal = Context.Service<Journal>("Journal");
