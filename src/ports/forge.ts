import { Context, type Effect } from "effect";
import type { FabrikaError } from "../errors.ts";

export type CheckState = "pass" | "fail" | "pending";

export type Check = {
  readonly name: string;
  readonly url: string;
  readonly state: CheckState;
  /** Set when the check is a CI job the forge can rerun and show a log for. */
  readonly job?: { readonly repo: string; readonly id: string; readonly jobId: string };
};

export type PullRequest = { readonly number: number; readonly url: string };

export type NewPullRequest = {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
};

/**
 * The code host: where a branch becomes a pull request and where its checks
 * are read. Bound to one repository, so nothing upstream carries an
 * `owner/repo` around.
 *
 * `settledChecks` is the deep one — it polls until every check of *that*
 * commit has finished, tolerates the window right after a push where the
 * rollup is still empty, and gives up at the timeout (`undefined`). A caller
 * that had to do this itself would have to know all three.
 */
export interface Forge {
  readonly repo: string;
  readonly urlOf: (pr: number) => string;
  readonly open: (input: NewPullRequest) => Effect.Effect<PullRequest, FabrikaError>;
  readonly settledChecks: (
    pr: number,
    sha: string,
    timeoutMinutes: number,
  ) => Effect.Effect<ReadonlyArray<Check> | undefined, FabrikaError>;
  /** The failed steps' log for a CI job, tail only; a link for anything else. */
  readonly failureLog: (check: Check) => Effect.Effect<string, FabrikaError>;
  /** Reruns a job's failed steps, for a suspected flake. */
  readonly rerun: (check: Check) => Effect.Effect<void, FabrikaError>;
}

export const Forge = Context.Service<Forge>("Forge");
