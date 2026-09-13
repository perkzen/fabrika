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

/**
 * What the forge says about a pull request against its base. `unknown` is
 * GitHub not having finished computing it, which is a thing to be told about
 * rather than a thing to guess at.
 */
export type MergeState = "conflicted" | "behind" | "clean" | "unknown";

export type PullRequestDetail = {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  /** The head branch, as a bare name. */
  readonly branch: string;
  /** The branch it targets, as a bare name. */
  readonly base: string;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  /** The head branch lives in another repository; nothing here can push to it. */
  readonly fork: boolean;
  readonly merge: MergeState;
};

export type NewPullRequest = {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  /** Absolute paths of images the body references; uploaded as the PR is opened. */
  readonly attachments: ReadonlyArray<string>;
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
 *
 * `authored` is deep the same way: the list query, the author filter and the
 * mapping onto four merge states sit behind one call, and the caller gets a
 * list it can filter.
 */
export interface Forge {
  readonly repo: string;
  readonly urlOf: (pr: number) => string;
  readonly open: (input: NewPullRequest) => Effect.Effect<PullRequest, FabrikaError>;
  /**
   * Whether a body may carry images uploaded from disk. False for a `gh`
   * without `--attach`, so the Before / After section is left out rather than
   * posted with paths only this machine can open.
   */
  readonly attaches: Effect.Effect<boolean>;
  /** The body as the forge actually posted it. */
  readonly body: (pr: number) => Effect.Effect<string, FabrikaError>;
  readonly editBody: (pr: number, body: string) => Effect.Effect<void, FabrikaError>;
  readonly settledChecks: (
    pr: number,
    sha: string,
    timeoutMinutes: number,
  ) => Effect.Effect<ReadonlyArray<Check> | undefined, FabrikaError>;
  /** The failed steps' log for a CI job, tail only; a link for anything else. */
  readonly failureLog: (check: Check) => Effect.Effect<string, FabrikaError>;
  /** Reruns a job's failed steps, for a suspected flake. */
  readonly rerun: (check: Check) => Effect.Effect<void, FabrikaError>;
  /** Open pull requests the authenticated operator authored, with their merge
   *  state settled as far as the forge will settle it. */
  readonly authored: Effect.Effect<ReadonlyArray<PullRequestDetail>, FabrikaError>;
}

export const Forge = Context.Service<Forge>("Forge");
