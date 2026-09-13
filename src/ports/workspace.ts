import { Context, type Effect } from "effect";
import type { FabrikaError } from "../errors.ts";

/**
 * What `git merge <base>` did. The plumbing — fetch, the behind count, the
 * exit code, the conflicted-file list — is the adapter's; a caller only has
 * to decide between "nothing to do", "carry on" and "someone has to resolve
 * this".
 */
export type MergeOutcome =
  | { readonly _tag: "UpToDate" }
  | { readonly _tag: "Merged"; readonly behind: number }
  | { readonly _tag: "Conflicted"; readonly behind: number; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "Failed"; readonly output: string };

/**
 * The checkout a run works in, bound to one repository, one worktree
 * directory and one base branch. Every call is about *this* run's tree, so no
 * caller passes a directory, a remote or a base ref around — which is what
 * kept those three threaded through every git call before.
 *
 * Not `acquireRelease`: an escalated run leaves the tree in place for a human
 * to look at. `remove` is called on the success path only.
 */
export interface Workspace {
  readonly dir: string;
  readonly repoRoot: string;
  /** Where stage artifacts live inside the tree, as an absolute path. */
  readonly artifactsDir: string;
  /** A stage artifact by file name; `undefined` when no stage wrote one. */
  readonly readArtifact: (name: string) => Effect.Effect<string | undefined, FabrikaError>;

  readonly exists: Effect.Effect<boolean>;
  readonly currentBranch: Effect.Effect<string, FabrikaError>;
  /** `git config user.name` as a branch-safe segment; fails when git has none. */
  readonly user: Effect.Effect<string, FabrikaError>;
  /** `owner/repo` of the base branch's remote. */
  readonly githubRepo: Effect.Effect<string, FabrikaError>;
  /**
   * Branches checked out in any worktree of this repository on this machine,
   * with where. The path comes with the branch because the reason it produces
   * has to name it: the tree a sweep left behind is the thing to clean up.
   */
  readonly checkedOutBranches: Effect.Effect<
    ReadonlyArray<{ readonly branch: string; readonly path: string }>,
    FabrikaError
  >;

  /** Creates the tree on `branch` off a freshly fetched base, or reuses one already on it. */
  readonly create: (branch: string) => Effect.Effect<void, FabrikaError>;
  /**
   * Makes the tree on `branch` *as the remote has it*, discarding any local
   * tip. A second operation beside `create` rather than a flag on it: a run
   * resumes through `create`, where unpushed commits are the run's own work.
   * Makes, never reuses — a directory already there belongs to something
   * else, and this one resets. See ADR-0004.
   */
  readonly checkout: (branch: string) => Effect.Effect<void, FabrikaError>;
  /** Runs the dependency install; `false` when the tree already had its dependencies. */
  readonly install: (command: string) => Effect.Effect<boolean, FabrikaError>;
  readonly remove: Effect.Effect<void, FabrikaError>;

  /** Commits everything if the tree is dirty; `false` when there was nothing to commit. */
  readonly commitAll: (message: string) => Effect.Effect<boolean, FabrikaError>;
  readonly emptyCommit: (message: string) => Effect.Effect<void, FabrikaError>;
  readonly head: Effect.Effect<string, FabrikaError>;
  /** The base's tip after a fetch — the commit a merge would bring in. */
  readonly baseHead: Effect.Effect<string, FabrikaError>;
  /** Commits on this branch that the base does not have. */
  readonly commitCount: Effect.Effect<number, FabrikaError>;
  /** Files this branch changes against the base. */
  readonly changedFiles: Effect.Effect<ReadonlyArray<string>, FabrikaError>;
  /** Files touched by commits since `sha`, exclusive. */
  readonly filesSince: (sha: string) => Effect.Effect<ReadonlyArray<string>, FabrikaError>;

  /** Fetches and merges the base — never rebases, so pushed commits stay put. */
  readonly mergeBase: Effect.Effect<MergeOutcome, FabrikaError>;
  readonly conflictedFiles: Effect.Effect<ReadonlyArray<string>, FabrikaError>;
  /** Commits a merge whose conflicts were resolved but not committed; `false` when none was in progress. */
  readonly finishMerge: Effect.Effect<boolean, FabrikaError>;

  readonly push: (branch: string) => Effect.Effect<void, FabrikaError>;
}

export const Workspace = Context.Service<Workspace>("Workspace");
