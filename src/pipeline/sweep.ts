import { Effect } from "effect";
import type { FabrikaError } from "../errors.ts";
import { Forge, type PullRequestDetail } from "../ports/forge.ts";
import { Journal, waitFor } from "../ports/journal.ts";
import { Workspace } from "../ports/workspace.ts";
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
};

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

const targetOf = (pr: PullRequestDetail): SyncTarget => ({ number: pr.number, url: pr.url, branch: pr.branch });

export const sweep = (
  options: SweepOptions,
): Effect.Effect<SweepResult, FabrikaError | StepError, Forge | Journal | Workspace> =>
  Effect.gen(function* () {
    const forge = yield* Forge;
    const journal = yield* Journal;

    const prs = yield* forge.authored;
    yield* journal.log(`sync: ${prs.length} open pull request(s) you authored on ${forge.repo}`);
    const selected = prs.filter((pr) => pr.merge === "conflicted");

    const outcomes: Array<SyncOutcome> = [];
    // Each worker's line is written when *it* finishes, not when the fan-out
    // does, so a sweep of six reports as it goes.
    yield* Effect.forEach(
      selected,
      (pr) =>
        Effect.gen(function* () {
          const target = targetOf(pr);
          const placement = yield* options.place(target);
          const { pushed } = yield* options.worker(target, placement);
          const outcome: SyncOutcome = pushed
            ? { pr, kind: "synced", detail: `synced: pushed ${pushed.slice(0, 7)}`, log: placement.log }
            : { pr, kind: "clean", detail: "already clean: base had not moved" };
          outcomes.push(outcome);
          yield* journal.log({ kind: "note", level: "detail", text: reported(outcome) });
        }),
      { concurrency: options.concurrency },
    ).pipe(waitFor(journal, `syncing ${selected.length} pull request(s)`));

    yield* journal.log(counts(outcomes));
    return { outcomes, exitCode: 0 };
  });
