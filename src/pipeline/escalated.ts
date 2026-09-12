import { Data } from "effect";

/**
 * The run stopped and a human has to look. Not a crash: the worktree is left
 * in place, the PR (if there is one) stays open, and rerunning the same
 * command resumes from the state on disk.
 */
export class Escalated extends Data.TaggedError("Escalated")<{
  readonly reason: string;
  readonly worktree: string;
  readonly prUrl?: string;
}> {}
