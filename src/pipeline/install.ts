import { Effect } from "effect";
import { Journal } from "../ports/journal.ts";
import { Workspace } from "../ports/workspace.ts";
import type { StepError } from "./step.ts";

/**
 * The dependency install, and what the operator is told about it.
 *
 * One module rather than the same eight lines in the two places a tree is
 * made ready — the run's workspace step and a sweep's worker — because the
 * command, the clock and the two lines it can end on are one thing to get
 * right. A repo that needs no install is a call that says nothing.
 *
 * The timing is the caller's rather than the port's: `Workspace.install`
 * answers whether it did anything, and how long a skipped install took is not
 * a fact about git.
 */
export const installDependencies = (
  command: string | undefined,
): Effect.Effect<void, StepError, Journal | Workspace> =>
  Effect.gen(function* () {
    if (!command) return;
    const workspace = yield* Workspace;
    const journal = yield* Journal;
    const started = Date.now();
    yield* journal.log(`install: ${command}`);
    const installed = yield* workspace.install(command);
    yield* journal.log(
      installed ? `install: ok (${((Date.now() - started) / 1000).toFixed(0)}s)` : `install: skipped (already present)`,
    );
  });
