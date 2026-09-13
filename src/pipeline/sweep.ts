/**
 * One sweep: list the operator's open pull requests, pick the conflicted ones
 * and hand each to a worker.
 *
 * The worker is a parameter because the layer graph one pull request needs —
 * its own worktree, run directory, gate and agent session — is composition-root
 * work. What belongs here is which pull requests get one, what their outcomes
 * add up to, and the lines the operator reads.
 */
import { Effect } from "effect";
import { baseBranch } from "../config.ts";
import type { FabrikaError } from "../errors.ts";
import { Forge, type PullRequestDetail } from "../ports/forge.ts";
import { Journal, waitFor } from "../ports/journal.ts";
import { Workspace } from "../ports/workspace.ts";
import { identified, openedByFabrika } from "../pull-request.ts";
import type { Escalated } from "./escalated.ts";
import type { StepError } from "./step.ts";
import { syncWithBase, type SyncServices } from "./sync.ts";

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

/** Whose pull request it is, off the trailer fabrika writes into every body. */
const whose = (pr: PullRequestDetail) => (openedByFabrika(pr.body) ? "[fabrika]" : "[yours]");

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
const failure = (pr: PullRequestDetail, placement: Placement | undefined, error: StepError): SyncOutcome => {
  if (error._tag === "Escalated") {
    return { pr, kind: "escalated", detail: `escalated: ${error.reason}`, worktree: error.worktree, log: placement?.log };
  }
  if (error._tag !== "AgentRateLimited") {
    return { pr, kind: "failed", detail: `failed: ${because(error)}`, log: placement?.log };
  }
  // The flag is what stops the sweep handing out new work, so it is set off the
  // error alone — naming the tree is the separate question of whether there is
  // one, and the operator coming back once the window resets wants both.
  return {
    pr,
    kind: "failed",
    detail: `failed: ${because(error)}`,
    log: placement?.log,
    worktree: placement?.worktree,
    rateLimited: true,
  };
};

/** A worker that threw rather than failed; the tree stays wherever it left it. */
const crashed = (pr: PullRequestDetail, placement: Placement | undefined, defect: unknown): SyncOutcome => ({
  pr,
  kind: "failed",
  detail: `failed: the worker crashed: ${defect}`,
  worktree: placement?.worktree,
  log: placement?.log,
});

/**
 * The number is in the key deliberately: two open pull requests can carry the
 * same identifier in their titles, and two workers in one tree is the failure
 * this command is not allowed to have.
 */
const targetOf = (pr: PullRequestDetail): SyncTarget => {
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

/**
 * One pull request's share of a sweep.
 *
 * It fails the way every other step fails — the sweep is the one place that
 * turns that into a value — and it removes its tree only on the way out
 * clean, so an escalation leaves exactly what an escalated run leaves.
 *
 * No review rounds and no forge call: the reviewer has already ruled on this
 * branch, and a merge commit is not a new implementation.
 */
export const syncPullRequest = (
  target: SyncTarget,
): Effect.Effect<{ readonly pushed: string | null }, StepError, SyncServices> =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const journal = yield* Journal;

    yield* workspace.checkout(target.branch);
    yield* journal.log(`worktree ${workspace.dir}`);
    if (target.install) {
      const started = Date.now();
      yield* journal.log(`install: ${target.install}`);
      const installed = yield* workspace.install(target.install);
      yield* journal.log(
        installed ? `install: ok (${((Date.now() - started) / 1000).toFixed(0)}s)` : `install: skipped (already present)`,
      );
    }

    // Read after `checkout` has fetched, so the key names the tip actually
    // being merged: it changes exactly when the thing being merged changes.
    const base = yield* workspace.baseHead;
    const moved = yield* syncWithBase({ prUrl: target.url, session: `sync-${base.slice(0, 7)}` });
    if (!moved) {
      yield* workspace.remove;
      return { pushed: null };
    }
    yield* workspace.push(target.branch);
    const head = yield* workspace.head;
    yield* workspace.remove;
    return { pushed: head };
  });

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
      // Two different answers: a repo with nothing conflicted needs no
      // attention, while one whose conflicted pull requests were all skipped
      // has something for the operator in the lines above. This is the line a
      // scheduled invocation reads, so it may not say the first when it is the
      // second.
      const why = prs.some((pr) => pr.merge === "conflicted") ? "every conflicted one skipped" : "none conflicted";
      yield* journal.log(`sync: nothing to sync — ${prs.length} open pull request(s), ${why} on ${options.base}`);
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
          const outcome = yield* options.place(target).pipe(
            Effect.flatMap((placement) =>
              options.worker(target, placement).pipe(
                Effect.match({
                  onSuccess: ({ pushed }): SyncOutcome =>
                    pushed
                      ? { pr, kind: "synced", detail: `synced: pushed ${pushed.slice(0, 7)}`, log: placement.log }
                      : { pr, kind: "clean", detail: "already clean: base had not moved" },
                  onFailure: (error) => failure(pr, placement, error),
                }),
                // A defect is not a failure, so the matching above does not see
                // it and it unwinds the fan-out instead. Crashing is the third
                // thing story 15 says one pull request may do on its own, and
                // the tree is left wherever the crash left it.
                Effect.catchDefect((defect) => Effect.succeed(crashed(pr, placement, defect))),
              ),
            ),
            // Inside the isolation, not before it: a placement that could not
            // be resolved is this pull request's failure, and the fan-out is
            // the one thing a single pull request may never take down.
            Effect.catch((error) => Effect.succeed(failure(pr, undefined, error))),
            Effect.catchDefect((defect) => Effect.succeed(crashed(pr, undefined, defect))),
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
