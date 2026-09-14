/**
 * One sweep: list the operator's open pull requests, pick the conflicted ones
 * and hand each to a worker.
 *
 * The fan-out and nothing else. Which pull requests get a worker is
 * `sweep-selection.ts`, what one worker does is `sync-worker.ts`, and what the
 * operator reads is `sweep-report.ts`; what is left here is handing the work
 * out, turning a worker's failure into a value, and the exit code.
 *
 * The worker is a parameter because the graph one pull request needs — its own
 * worktree, run directory, gate and agent session — is composition-root work.
 */
import { Effect } from "effect";
import type { FabrikaError } from "../errors.ts";
import { Forge, type PullRequestDetail } from "../ports/forge.ts";
import { Journal, waitFor } from "../ports/journal.ts";
import { Workspace } from "../ports/workspace.ts";
import type { Escalated } from "./escalated.ts";
import type { StepError } from "./step.ts";
import { select, targetOf, type SyncTarget } from "./sweep-selection.ts";
import { counts, label, reported, rowAbout, rowTitle, type SyncOutcome } from "./sweep-report.ts";

/** Where one worker's tree and log live; the composition root decides both. */
export type Placement = {
  readonly worktree: string;
  readonly log: string;
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
    // filesystem read on this path, and a dry run promises to touch nothing —
    // a screen included, which is why this returns above the `run` event.
    if (options.dryRun) {
      for (const pr of selected) {
        const text = `${label(pr)} — would sync ${pr.branch} into ${options.base}`;
        yield* journal.log({ kind: "note", level: "detail", text });
      }
      yield* journal.log(`dry run: ${selected.length} would be synced, ${skipped} skipped; nothing changed`);
      return { outcomes, exitCode: 0 };
    }

    /** A pull request's own row, by the position it holds in the selection. */
    const rows = selections.map((selection, index) => ({
      selection,
      target: targetOf(selection.pr),
      at: index + 1,
      of: selections.length,
    }));
    const rowOf = (pr: PullRequestDetail) => rows.find((row) => row.selection.pr === pr)!;

    // The sweep as the shape a presenter draws: one row per pull request it
    // considered, skipped ones included, so the row count is the answer the
    // line above just gave. The rows are what a worker's events are addressed
    // to, so this is emitted before the first one is handed out.
    yield* journal.log({
      kind: "run",
      completed: [],
      steps: rows.map(({ selection, target }) => ({
        name: target.key,
        title: rowTitle(selection.pr, target),
        about: rowAbout(selection.pr, target, options.base, selection.decision === "sync"),
        done: false,
      })),
    });
    // After the `run` event, because a row cannot be skipped before it exists;
    // the line each of these was reported on is already in scrollback above.
    for (const { selection, target, at, of } of rows) {
      if (selection.decision !== "skip") continue;
      yield* journal.log({ kind: "step", name: target.key, title: rowTitle(selection.pr, target), at, of, state: "skipped", reason: selection.reason });
    }

    // Each worker's line is written when *it* finishes, not when the fan-out
    // does, so a sweep of six reports as it goes.
    yield* Effect.forEach(
      selected,
      (pr) =>
        Effect.gen(function* () {
          const { target, at, of } = rowOf(pr);
          const title = rowTitle(pr, target);
          if (rateLimited) {
            const stopped: SyncOutcome = { pr, kind: "skipped", detail: "skipped: usage limit hit — not started" };
            outcomes.push(stopped);
            yield* journal.log({ kind: "step", name: target.key, title, at, of, state: "skipped", reason: "usage limit hit — not started" });
            return yield* journal.log({ kind: "note", level: "detail", text: reported(stopped) });
          }
          const started = Date.now();
          yield* journal.log({ kind: "step", name: target.key, title, at, of, state: "start" });
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
          yield* journal.log({
            kind: "step",
            name: target.key,
            title,
            at,
            of,
            state: "end",
            seconds: (Date.now() - started) / 1000,
            // What the row's marker reads: `synced` and `already clean` are
            // done, and everything a human has to come back to is failed.
            outcome: outcome.kind === "synced" || outcome.kind === "clean" ? "done" : "failed",
          });
          yield* journal.log({ kind: "note", level: "detail", text: reported(outcome) });
        }),
      { concurrency: options.concurrency },
    ).pipe(waitFor(journal, `syncing ${selected.length} pull request(s)`));

    const needsAHuman = outcomes.some((outcome) => outcome.kind === "escalated" || outcome.kind === "failed");
    // The counts as the `result` event rather than a line: a screen writes
    // nothing after it mounts but the exit scrollback, and the contract is
    // that this is the last line on stdout. Its text is unchanged, and the
    // plain rendering of a result is its text verbatim.
    yield* journal.log({ kind: "result", outcome: needsAHuman ? "escalated" : "done", text: counts(outcomes) });
    return { outcomes, exitCode: rateLimited ? 3 : needsAHuman ? 2 : 0 };
  });
