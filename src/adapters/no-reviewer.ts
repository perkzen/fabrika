import { Effect, Layer } from "effect";
import { Reviewer } from "../ports/reviewer.ts";

/**
 * The reviewer for a repo that has no review bot: it reviews nothing.
 *
 * `await` returns immediately rather than timing out, because `undefined`
 * means *no review arrived, escalate* — the exact ending this adapter exists
 * to remove. The synthetic review it returns carries no score and no threads,
 * so the round is decided by the repo's own checks alone.
 *
 * The port's thread-shaped members are inert here, not merely unused: the
 * review loop reads every one of them inside `if (threads.length > 0)`, and
 * these threads are always empty. ADR-0002 records why the port is not split.
 */
export const noReviewer: Reviewer = {
  name: "none",
  scores: false,
  // No review bot means no check on the PR belongs to a reviewer, so every
  // check the forge classifies is the repo's CI — which is what the loop waits on.
  owns: () => false,
  await: (_pr, commits) => Effect.succeed({ commit: commits.at(-1) ?? "", score: null, threads: [] }),
  reply: () => Effect.void,
  resolve: () => Effect.void,
  renderThreads: () => "",
  decisionSchema: "{}",
  prompts: { threads: "", system: "" },
};

export const layer = Layer.succeed(Reviewer)(noReviewer);
