import { Context, type Effect } from "effect";
import type { CaptureStep } from "../config.ts";
import type { Shot } from "../captures.ts";

/**
 * What the pull request may show of the change a diff cannot: each capture
 * run at the base and in the run's own tree.
 *
 * One operation, because the caller has one question. That the base is a
 * separate checkout, that it is cached by sha, that a command is bounded and
 * that a text file is capped are all behind it.
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
