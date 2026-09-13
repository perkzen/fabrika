import { Context, type Effect } from "effect";
import type { CaptureStep } from "../config.ts";
import type { Shot } from "../domain/captures.ts";

/**
 * What the pull request may show of the change a diff cannot: each capture
 * run at the base and in the run's own tree.
 *
 * That the base is a separate checkout, that it is cached by sha, that a
 * command is bounded and that a text file is capped are all behind the one
 * operation. Deciding *which* captures apply to the branch is not: the step
 * filters by `when` before it calls, so a branch that changed no captured
 * surface is a call that never happens — and is assertable as such.
 */
export interface Captures {
  /**
   * Never fails and has no error channel: a non-zero exit, a timeout, an
   * overrun cap, an empty directory or a base that will not check out all
   * produce a shot with that half missing. The caller only renders what it is
   * given.
   */
  readonly take: (captures: ReadonlyArray<CaptureStep>, baseSha: string) => Effect.Effect<ReadonlyArray<Shot>>;
}

export const Captures = Context.Service<Captures>("Captures");
