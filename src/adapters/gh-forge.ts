import { Duration, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { asFabrikaError, FabrikaError } from "../errors.ts";
import { exec, run } from "../infra/shell.ts";
import { Forge, type Check, type CheckState, type MergeState, type NewPullRequest, type PullRequestDetail } from "../ports/forge.ts";
import { Journal, waitFor } from "../ports/journal.ts";
import { Reviewer } from "../ports/reviewer.ts";
import { Workspace } from "../ports/workspace.ts";

/**
 * GitHub through the `gh` CLI, which already holds the operator's
 * credentials. Every call carries `-R <owner/repo>` because a monorepo can
 * have more than one remote and the worktree's default is not always the one
 * the PR lives in.
 *
 * The rollup shapes below were read off live PRs (2026-09-10), not assumed.
 * Two kinds arrive: `CheckRun` (Actions and apps) and `StatusContext` (commit
 * statuses, e.g. Vercel). The head sha comes with them, so "the checks of the
 * commit I just pushed" is distinguishable from "the checks of the one before".
 */
type Rollup = {
  headRefOid: string;
  statusCheckRollup: Array<
    | { __typename: "CheckRun"; name: string; status: string; conclusion: string; detailsUrl: string; workflowName: string }
    | { __typename: "StatusContext"; context: string; state: string; targetUrl: string }
  >;
};

const GOOD = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

const actionsJob = (url: string) => {
  const match = /github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(url);
  return match ? { repo: match[1]!, id: match[2]!, jobId: match[3]! } : undefined;
};

export const classify = (rollup: Rollup["statusCheckRollup"], ignore: (name: string, url: string) => boolean): Array<Check> =>
  rollup.flatMap((entry) => {
    if (entry.__typename === "StatusContext") {
      if (ignore(entry.context, entry.targetUrl)) return [];
      const state: CheckState =
        entry.state === "SUCCESS" ? "pass" : entry.state === "PENDING" || entry.state === "EXPECTED" ? "pending" : "fail";
      return [{ name: entry.context, url: entry.targetUrl, state }];
    }
    if (ignore(entry.name, entry.detailsUrl)) return [];
    const state: CheckState = entry.status !== "COMPLETED" ? "pending" : GOOD.has(entry.conclusion) ? "pass" : "fail";
    const job = actionsJob(entry.detailsUrl);
    return [
      {
        name: entry.workflowName ? `${entry.workflowName} / ${entry.name}` : entry.name,
        url: entry.detailsUrl,
        state,
        ...(job ? { job } : {}),
      },
    ];
  });

/** One entry of the listing below; GitHub sends `state`, `mergeable` and `mergeStateStatus` uppercase. */
type Listed = {
  number: number;
  url: string;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  mergeable: string;
  mergeStateStatus?: string;
};

const LIST_FIELDS =
  "number,url,title,body,headRefName,baseRefName,state,isDraft,isCrossRepository,mergeable,mergeStateStatus";

/**
 * GitHub's two fields onto the four states.
 *
 * `mergeStateStatus` only separates `behind` from `clean`, both of which a
 * sweep skips: it is reported only under branch protection that requires
 * up-to-date branches, and it is the expensive half of the query, so nothing
 * load-bearing may depend on it. Anything that is neither `CONFLICTING` nor
 * `MERGEABLE` is GitHub still computing, which is `unknown` rather than a
 * guess in either direction.
 */
export const mergeStateOf = (mergeable: string, mergeStateStatus?: string): MergeState =>
  mergeable === "CONFLICTING"
    ? "conflicted"
    : mergeable !== "MERGEABLE"
      ? "unknown"
      : mergeStateStatus === "BEHIND"
        ? "behind"
        : "clean";

const detailOf = (pr: Listed): PullRequestDetail => ({
  number: pr.number,
  url: pr.url,
  title: pr.title,
  body: pr.body,
  branch: pr.headRefName,
  base: pr.baseRefName,
  state: pr.state.toLowerCase() as PullRequestDetail["state"],
  draft: pr.isDraft,
  fork: pr.isCrossRepository,
  merge: mergeStateOf(pr.mergeable, pr.mergeStateStatus),
});

export type ForgeOptions = {
  /** The branch PRs target, without the remote. */
  readonly base: string;
};

/** A rollup can be empty for a moment after a push, or forever in a repo with no CI. */
const EMPTY_ROLLUP_GRACE = Duration.minutes(2);
const POLL = Duration.seconds(60);

export const layer = (options: ForgeOptions) =>
  Layer.effect(Forge)(
    Effect.gen(function* () {
      const workspace = yield* Workspace;
      const journal = yield* Journal;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const repo = yield* workspace.githubRepo;
      // The reviewer reports itself as a check on the PR. The review loop owns
      // that signal, so waiting for it here would be waiting on the loop's own
      // output — which bot it is stays the reviewer's business, not GitHub's.
      const reviewer = yield* Reviewer;
      const spawned = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
        Effect.provideService(effect, ChildProcessSpawner.ChildProcessSpawner, spawner);
      const gh = (argv: ReadonlyArray<string>) =>
        spawned(run(workspace.dir, ["gh", ...argv])).pipe(Effect.mapError(asFabrikaError(`gh ${argv[0]} ${argv[1] ?? ""}`.trim())));

      const rollup = (pr: number) =>
        gh(["pr", "view", String(pr), "-R", repo, "--json", "headRefOid,statusCheckRollup"]).pipe(
          Effect.map((out) => {
            const parsed = JSON.parse(out) as Rollup;
            return { sha: parsed.headRefOid, checks: classify(parsed.statusCheckRollup, reviewer.owns) };
          }),
        );

      return {
        repo,
        urlOf: (pr: number) => `https://github.com/${repo}/pull/${pr}`,

        open: (input: NewPullRequest) =>
          gh([
            "pr", "create", "-R", repo,
            "--head", input.branch,
            "--base", options.base,
            "--title", input.title,
            "--body", input.body,
            ...(input.draft ? ["--draft"] : []),
          ]).pipe(
            Effect.flatMap((out) => {
              const number = /\/pull\/(\d+)/.exec(out)?.[1];
              return number
                ? Effect.succeed({ number: Number(number), url: `https://github.com/${repo}/pull/${number}` })
                : Effect.fail(new FabrikaError({ message: `gh pr create returned no PR URL: ${out}` }));
            }),
          ),

        // One wait for the whole poll loop. The per-poll `(2 pending)`
        // parenthetical goes with it: it was poll state, and the presenter
        // has no way to know it.
        settledChecks: (pr: number, sha: string, timeoutMinutes: number) =>
          Effect.gen(function* () {
            const started = Date.now();
            const deadline = started + timeoutMinutes * 60_000;
            while (true) {
              const current = yield* rollup(pr);
              const settled = current.sha === sha && current.checks.every((check) => check.state !== "pending");
              const graceOver = Date.now() - started > Duration.toMillis(EMPTY_ROLLUP_GRACE);
              if (settled && (current.checks.length > 0 || graceOver)) return current.checks;
              if (Date.now() >= deadline) return undefined;
              yield* Effect.sleep(POLL);
            }
          }).pipe(waitFor(journal, `checks on ${sha.slice(0, 7)}`, timeoutMinutes)),

        failureLog: (check: Check) =>
          check.job
            ? spawned(exec(workspace.dir, ["gh", "run", "view", "--job", check.job.jobId, "--log-failed", "-R", check.job.repo])).pipe(
                Effect.mapError(asFabrikaError("gh run view")),
                Effect.map((result) => {
                  const lines = result.out.split("\n").filter((line) => line.trim());
                  return lines.slice(-120).join("\n").slice(-8000) || `(no failed-step log; exit ${result.code})`;
                }),
              )
            : Effect.succeed(`(not a CI job with a readable log; see ${check.url})`),

        rerun: (check: Check) =>
          check.job ? gh(["run", "rerun", check.job.id, "--failed", "-R", check.job.repo]).pipe(Effect.asVoid) : Effect.void,

        // `--limit` is explicit because `gh`'s default of 30 drops pull
        // requests silently; `--base` is deliberately absent, because a
        // stacked pull request has to be listed to be reported.
        authored: gh([
          "pr", "list", "-R", repo,
          "--author", "@me",
          "--state", "open",
          "--limit", "200",
          "--json", LIST_FIELDS,
        ]).pipe(Effect.map((out) => (JSON.parse(out) as Array<Listed>).map(detailOf))),
      } satisfies Forge;
    }),
  );
