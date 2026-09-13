/**
 * What a sweep tells the operator: one line per pull request, and the counts
 * line last.
 *
 * Pure, and separate from the fan-out that emits it, because the last line is
 * the contract a scheduled invocation is read through — it is worth being able
 * to see every wording in one place, without a fan-out around it.
 */
import type { PullRequestDetail } from "../ports/forge.ts";
import { openedByFabrika } from "../domain/pull-request.ts";
import type { SyncTarget } from "./sweep-selection.ts";

export type SyncOutcome = {
  readonly pr: PullRequestDetail;
  readonly kind: "synced" | "clean" | "escalated" | "failed" | "skipped";
  readonly detail: string;
  readonly worktree?: string;
  readonly log?: string;
  /** The one failure that stops the sweep handing out new work. */
  readonly rateLimited?: boolean;
};

/** Whose pull request it is, off the trailer fabrika writes into every body. */
const whose = (pr: PullRequestDetail) => (openedByFabrika(pr.body) ? "[fabrika]" : "[yours]");

export const label = (pr: PullRequestDetail) => `#${pr.number} ${whose(pr)} ${pr.title}`;

/**
 * What a row is called on a screen: short, because every title is padded to
 * the widest one and capped, and the number is what the operator goes back to
 * GitHub with. The identifier joins it when the title carries one — a row
 * reading `#42 pr-42` says the same thing twice.
 */
export const rowTitle = (pr: PullRequestDetail, target: SyncTarget) =>
  target.identifier === `pr-${pr.number}` ? `#${pr.number}` : `#${pr.number} ${target.identifier}`;

/**
 * What a row says before anything has happened to it: whose pull request it is
 * and what it is called, with the identifier the title already carries taken
 * off the front — which the title has no room for — and, for one the
 * sweep is about to touch, the line the dry run would have written.
 */
export const rowAbout = (pr: PullRequestDetail, target: SyncTarget, base: string, selected: boolean) =>
  `${whose(pr)} ${target.title}${selected ? ` — would sync ${target.branch} into ${base}` : ""}`;

/** An outcome as its console line: the parts that are set, in one dash-joined run. */
export const reported = (outcome: SyncOutcome) =>
  [
    `${label(outcome.pr)} — ${outcome.detail}`,
    ...(outcome.worktree ? [`worktree: ${outcome.worktree}`] : []),
    ...(outcome.log ? [`log: ${outcome.log}`] : []),
  ].join(" — ");

/**
 * The last line, and the contract a scheduled invocation is read through.
 *
 * `already clean` is its own field rather than folded into `synced`: the pull
 * request was conflicted when GitHub was asked, so a merge that found nothing
 * to do is a fact worth reporting rather than a push that did not happen.
 */
export const counts = (outcomes: ReadonlyArray<SyncOutcome>) => {
  const of = (kind: SyncOutcome["kind"]) => outcomes.filter((outcome) => outcome.kind === kind).length;
  return `sync: ${of("synced")} synced, ${of("clean")} already clean, ${of("escalated")} escalated, ${of("failed")} failed, ${of("skipped")} skipped`;
};
