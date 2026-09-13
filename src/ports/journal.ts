import { Context, Effect } from "effect";
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

/**
 * The effect as the wait it is: one `start` when it opens, one `end` carrying
 * how long it took, and the `end` written whichever way it goes out — a wait
 * left open animates forever.
 *
 * The clock is read inside the effect rather than where the wait is built,
 * so an effect run twice is timed twice. A free function over the interface
 * rather than a method on it: `Reviewer.await` and `Forge.settledChecks`
 * declare what they need, and a wait must not add `Journal` to it.
 */
export const waitFor =
  (journal: Journal, subject: string, deadlineMinutes?: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const started = Date.now();
      return journal.log({ kind: "wait", state: "start", subject, deadlineMinutes }).pipe(
        Effect.andThen(effect),
        // Suspended, because `ensuring` builds its argument up front: reading
        // the clock in the literal would time nothing at all and every wait
        // would end `waited 0s`.
        Effect.ensuring(
          Effect.suspend(() =>
            journal.log({ kind: "wait", state: "end", subject, seconds: (Date.now() - started) / 1000 }),
          ),
        ),
      );
    });
