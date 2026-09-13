import { Effect } from "effect";
import { baseBranch } from "../adapters/git-workspace.ts";
import type { FabrikaError } from "../errors.ts";
import { Forge, type PullRequestDetail } from "../ports/forge.ts";
import { Journal, waitFor } from "../ports/journal.ts";
import { Workspace } from "../ports/workspace.ts";
import type { Escalated } from "./escalated.ts";
import type { StepError } from "./step.ts";

/**
 * One sweep: list the operator's open pull requests, pick the conflicted ones
 * and hand each to a worker.
 *
 * The worker is a parameter because the layer graph one pull request needs —
 * its own worktree, run directory, gate and agent session — is composition-root
 * work. What belongs here is which pull requests get one, what their outcomes
 * add up to, and the lines the operator reads.
 */
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

/** Where one worker's tree and log live; the composition root decides both. */
export type Placement = {
  readonly worktree: string;
  readonly log: string;
};

export type SyncOutcome = {
  readonly pr: PullRequestDetail;
  readonly kind: "synced" | "clean" | "escalated" | "failed" | "skipped";
  readonly detail: string;
  readonly worktree?: string;
  readonly log?: string;
  /** The one failure that stops the sweep handing out new work. */
  readonly rateLimited?: boolean;
};

export type SweepOptions = {
  /** The configured form, `origin/main`: what the reported lines say. */
  readonly base: string;
  readonly concurrency: number;
  readonly dryRun: boolean;
  readonly place: (target: SyncTarget) => Effect.Effect<Placement, FabrikaError>;
  /** One pull request's work, failing the way a step fails; the sweep turns that into a value. */
  readonly worker: (
    target: SyncTarget,
    placement: Placement,
  ) => Effect.Effect<{ readonly pushed: string | null }, StepError>;
};

export type SweepResult = {
  readonly outcomes: ReadonlyArray<SyncOutcome>;
  readonly exitCode: 0 | 2 | 3;
};

/** Whose pull request it is, off the trailer `pull-request.ts` stamps into every body. */
const whose = (pr: PullRequestDetail) => (pr.body.includes("Opened by fabrika") ? "[fabrika]" : "[yours]");

const label = (pr: PullRequestDetail) => `#${pr.number} ${whose(pr)} ${pr.title}`;

/** An outcome as its console line: the parts that are set, in one dash-joined run. */
const reported = (outcome: SyncOutcome) =>
  [
    `${label(outcome.pr)} — ${outcome.detail}`,
    ...(outcome.worktree ? [`worktree: ${outcome.worktree}`] : []),
    ...(outcome.log ? [`log: ${outcome.log}`] : []),
  ].join(" — ");

const counts = (outcomes: ReadonlyArray<SyncOutcome>) => {
  const of = (kind: SyncOutcome["kind"]) => outcomes.filter((outcome) => outcome.kind === kind).length;
  return `sync: ${of("synced")} synced, ${of("clean")} already clean, ${of("escalated")} escalated, ${of("failed")} failed, ${of("skipped")} skipped`;
};

/** What a worker's failure says on one line; `Escalated` has its own, richer form. */
const because = (error: Exclude<StepError, Escalated>) => {
  switch (error._tag) {
    case "FabrikaError":
      return error.message;
    case "AgentRateLimited":
      return "usage limit hit";
    // The auth probe has already run, so an unauthorized agent mid-sweep is
    // as unexpected as any other failure.
    case "AgentUnauthorized":
      return `claude cannot authenticate: ${error.message}`;
    case "AgentFailed":
      return `the agent call failed (exit ${error.exitCode})`;
  }
};

/**
 * A worker's failure as a value. The conversion is the sweep's, not the
 * worker factory's: left as a failure, the first one would take the whole
 * fan-out down, and a test that hands over a pre-converted worker would
 * exercise nothing but its own fixture.
 */
const failure = (pr: PullRequestDetail, placement: Placement, error: StepError): SyncOutcome => {
  if (error._tag === "Escalated") {
    return { pr, kind: "escalated", detail: `escalated: ${error.reason}`, worktree: error.worktree, log: placement.log };
  }
  const failed: SyncOutcome = { pr, kind: "failed", detail: `failed: ${because(error)}`, log: placement.log };
  // The tree is left mid-merge and this is the failure an operator comes back
  // to once the window resets, so the line has to say where it is.
  return error._tag === "AgentRateLimited"
    ? { ...failed, worktree: placement.worktree, rateLimited: true }
    : failed;
};

/** The shape `pull-request.ts` writes: `FAB-5: Conflicted PRs pile up`. */
const TITLED = /^([A-Za-z][A-Za-z0-9]*-\d+)\s*:\s*(.*)$/;

/**
 * The number is in the key deliberately: two open pull requests can carry the
 * same identifier in their titles, and two workers in one tree is the failure
 * this command is not allowed to have.
 */
const targetOf = (pr: PullRequestDetail): SyncTarget => {
  const titled = TITLED.exec(pr.title);
  const identifier = titled ? titled[1]! : `pr-${pr.number}`;
  return {
    number: pr.number,
    url: pr.url,
    branch: pr.branch,
    identifier,
    title: titled ? titled[2]! : pr.title,
    key: titled ? `${identifier}-${pr.number}` : identifier,
  };
};

/**
 * Which pull requests a sweep may touch, and why it left the rest alone.
 *
 * Pure, and first match wins, so the reason an operator reads is deterministic
 * — a merged pull request reports `mergeable: UNKNOWN` forever, so the state
 * rule has to fire before the unknown one. It stays unexported: the reason a
 * pull request was skipped is what the operator reads, so that is what a test
 * should read too.
 */
const select = (
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

export const sweep = (
  options: SweepOptions,
): Effect.Effect<SweepResult, FabrikaError, Forge | Journal | Workspace> =>
  Effect.gen(function* () {
    const forge = yield* Forge;
    const journal = yield* Journal;
    const workspace = yield* Workspace;

    const prs = yield* forge.authored;
    // Both no-op lines return before the fan-out, so the command is safe to
    // put on a schedule in a repo that has nothing for it to do.
    if (prs.length === 0) {
      yield* journal.log(`sync: nothing to sync — no open pull request(s) you authored on ${forge.repo}`);
      return { outcomes: [], exitCode: 0 };
    }
    yield* journal.log(`sync: ${prs.length} open pull request(s) you authored on ${forge.repo}`);
    const selections = select(prs, { base: options.base, checkedOut: yield* workspace.checkedOutBranches });
    const selected = selections.flatMap((selection) => (selection.decision === "sync" ? [selection.pr] : []));

    const outcomes: Array<SyncOutcome> = [];
    // A plain closure variable: one process, one fiber tree, every write
    // inside a worker's own effect. Cancelling a worker already in flight
    // would abandon a tree mid-merge, which is worse than finishing it.
    let rateLimited = false;
    // In list order, before anything is touched: "nothing to do" and "fabrika
    // decided not to" are different answers and the operator reads both here.
    for (const selection of selections) {
      if (selection.decision !== "skip") continue;
      const outcome: SyncOutcome = { pr: selection.pr, kind: "skipped", detail: `skipped: ${selection.reason}` };
      outcomes.push(outcome);
      yield* journal.log({ kind: "note", level: "detail", text: reported(outcome) });
    }
    const skipped = selections.length - selected.length;
    if (selected.length === 0) {
      yield* journal.log(`sync: nothing to sync — ${prs.length} open pull request(s), none conflicted on ${options.base}`);
      return { outcomes, exitCode: 0 };
    }
    yield* journal.log(`sync: ${selected.length} conflicted, ${skipped} skipped`);

    // Before any path is resolved: the run-directory scan is the only
    // filesystem read on this path, and a dry run promises to touch nothing.
    if (options.dryRun) {
      for (const pr of selected) {
        const text = `${label(pr)} — would sync ${pr.branch} into ${options.base}`;
        yield* journal.log({ kind: "note", level: "detail", text });
      }
      yield* journal.log(`dry run: ${selected.length} would be synced, ${skipped} skipped; nothing changed`);
      return { outcomes, exitCode: 0 };
    }

    // Each worker's line is written when *it* finishes, not when the fan-out
    // does, so a sweep of six reports as it goes.
    yield* Effect.forEach(
      selected,
      (pr) =>
        Effect.gen(function* () {
          if (rateLimited) {
            const stopped: SyncOutcome = { pr, kind: "skipped", detail: "skipped: usage limit hit — not started" };
            outcomes.push(stopped);
            return yield* journal.log({ kind: "note", level: "detail", text: reported(stopped) });
          }
          const target = targetOf(pr);
          const placement = yield* options.place(target);
          const outcome = yield* options.worker(target, placement).pipe(
            Effect.match({
              onSuccess: ({ pushed }): SyncOutcome =>
                pushed
                  ? { pr, kind: "synced", detail: `synced: pushed ${pushed.slice(0, 7)}`, log: placement.log }
                  : { pr, kind: "clean", detail: "already clean: base had not moved" },
              onFailure: (error) => failure(pr, placement, error),
            }),
          );
          outcomes.push(outcome);
          rateLimited ||= outcome.rateLimited === true;
          yield* journal.log({ kind: "note", level: "detail", text: reported(outcome) });
        }),
      { concurrency: options.concurrency },
    ).pipe(waitFor(journal, `syncing ${selected.length} pull request(s)`));

    yield* journal.log(counts(outcomes));
    const needsAHuman = outcomes.some((outcome) => outcome.kind === "escalated" || outcome.kind === "failed");
    return { outcomes, exitCode: rateLimited ? 3 : needsAHuman ? 2 : 0 };
  });
