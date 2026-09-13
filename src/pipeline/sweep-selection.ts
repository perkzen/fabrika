/**
 * Which pull requests a sweep touches, and why it leaves the rest alone.
 *
 * On its own and pure, because the rules are the part of a sweep an operator
 * argues with: every line written about a pull request that was left alone
 * comes from here.
 */
import { baseBranch } from "../config.ts";
import type { PullRequestDetail } from "../ports/forge.ts";
import { identified } from "../domain/pull-request.ts";

export type SyncTarget = {
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  /** `FAB-5`, or `pr-42` when the title does not parse. */
  readonly identifier: string;
  /** What `prompts/merge.md` interpolates: the title without its identifier. */
  readonly title: string;
  /** The worktree and run directory's name. */
  readonly key: string;
  readonly install?: string;
};

export type Selection =
  | { readonly decision: "sync"; readonly pr: PullRequestDetail }
  | { readonly decision: "skip"; readonly pr: PullRequestDetail; readonly reason: string };

/**
 * The number is in the key deliberately: two open pull requests can carry the
 * same identifier in their titles, and two workers in one tree is the failure
 * this command is not allowed to have.
 */
export const targetOf = (pr: PullRequestDetail): SyncTarget => {
  const titled = identified(pr.title);
  return {
    number: pr.number,
    url: pr.url,
    branch: pr.branch,
    identifier: titled ? titled.identifier : `pr-${pr.number}`,
    title: titled ? titled.title : pr.title,
    key: titled ? `${titled.identifier}-${pr.number}` : `pr-${pr.number}`,
  };
};

/**
 * Which pull requests a sweep may touch, and why it left the rest alone.
 *
 * First match wins, so the reason an operator reads is deterministic — a
 * merged pull request reports `mergeable: UNKNOWN` forever, so the state rule
 * has to fire before the unknown one, and rule six is load-bearing for the
 * hard reset behind it (ADR-0004).
 *
 * The reason is still what the operator reads and the sweep's own tests still
 * read it there. What a function of its own buys is that the order of the six
 * rules can be stated once, as a table, rather than inferred from six console
 * lines written by a fan-out.
 */
export const select = (
  prs: ReadonlyArray<PullRequestDetail>,
  options: {
    readonly base: string;
    readonly checkedOut: ReadonlyArray<{ readonly branch: string; readonly path: string }>;
  },
): ReadonlyArray<Selection> => {
  const ours = baseBranch(options.base);
  return prs.map((pr): Selection => {
    const skip = (reason: string): Selection => ({ decision: "skip", pr, reason });
    if (pr.state !== "open") return skip(pr.state === "merged" ? "already merged" : "closed");
    if (pr.fork) return skip("opened from a fork; nothing here can push to it");
    if (pr.base !== ours) return skip(`targets ${pr.base}, not ${ours}`);
    if (pr.merge === "unknown") return skip("merge state unknown — GitHub would not compute it");
    if (pr.merge !== "conflicted") return skip(`not conflicted (${pr.merge})`);
    const tree = options.checkedOut.find((entry) => entry.branch === pr.branch);
    if (tree) return skip(`branch is checked out at ${tree.path}`);
    return { decision: "sync", pr };
  });
};
