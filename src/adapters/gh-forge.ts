import { Duration, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { asFabrikaError, FabrikaError } from "../errors.ts";
import { exec, run } from "../infra/shell.ts";
import { Forge, type Check, type CheckState, type MergeState, type NewPullRequest, type PullRequestDetail } from "../ports/forge.ts";
import { Journal, waitFor } from "../ports/journal.ts";
import { Reviewer } from "../ports/reviewer.ts";

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
const Listed = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  title: Schema.String,
  body: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  isCrossRepository: Schema.Boolean,
  mergeable: Schema.String,
  mergeStateStatus: Schema.optional(Schema.String),
});
type Listed = typeof Listed.Type;

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

/**
 * GitHub's `state` onto the three the port speaks. A decision, not a cast:
 * `Listed.state` is an unconstrained string, so asserting the union over it
 * would be the schema guarding nothing. Anything unrecognised is closed —
 * `select`'s first rule skips it, which costs one pull request rather than
 * acting on a state this does not understand.
 */
const stateOf = (state: string): PullRequestDetail["state"] =>
  state === "OPEN" ? "open" : state === "MERGED" ? "merged" : "closed";

const detailOf = (pr: Listed): PullRequestDetail => ({
  number: pr.number,
  url: pr.url,
  title: pr.title,
  body: pr.body,
  branch: pr.headRefName,
  base: pr.baseRefName,
  state: stateOf(pr.state),
  draft: pr.isDraft,
  fork: pr.isCrossRepository,
  merge: mergeStateOf(pr.mergeable, pr.mergeStateStatus),
});

const decoded = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Listed)));

/**
 * `gh pr list --json` output as pull requests. Decoded, not cast.
 *
 * The subprocess is a trust boundary and this is everything a sweep decides
 * on — which tree it hard-resets, which key it writes under, which branch it
 * pushes. A cast makes a row that is not a pull request a *defect* thrown
 * inside `Effect.map`, which no `catch` recovers and which the sweep's
 * per-pull-request isolation does not hold either: one strange row would take
 * the whole sweep down where a failed listing stops it saying why.
 */
export const listing = (out: string): Effect.Effect<ReadonlyArray<PullRequestDetail>, FabrikaError> =>
  decoded(out).pipe(
    Effect.map((prs) => prs.map(detailOf)),
    Effect.mapError(asFabrikaError("reading gh pr list")),
  );

export type ForgeOptions = {
  readonly repo: string;
  /** The branch PRs target, without the remote. */
  readonly base: string;
  /** Where `gh` is spawned. Incidental — every call carries `-R` — but a
   *  subprocess needs a directory, and a sweep has no worktree at discovery. */
  readonly cwd: string;
};

/** A rollup can be empty for a moment after a push, or forever in a repo with no CI. */
const EMPTY_ROLLUP_GRACE = Duration.minutes(2);
const POLL = Duration.seconds(60);

/** Long enough for GitHub to finish what the first listing asked it to start. */
const REFRESH_GAP = Duration.seconds(3);
const REFRESH_ATTEMPTS = 2;

/**
 * One listing, asked again until every merge state is settled.
 *
 * GitHub computes mergeability lazily and the query itself is what triggers
 * it, so a pull request it has not got to yet comes back `unknown` and the
 * refresh is the same list again — one call that resolves every pending pull
 * request at once, where one call per pull request would cost one each.
 * Measured 2026-09-13: a first listing of 100 came back 49 unknown, an
 * immediate repeat all 100 resolved.
 *
 * This decides whether a sweep sees anything at all — every `unknown` left
 * here is a pull request the selection rule skips — so `listed` is a
 * parameter: it is the one true external, and everything around it is
 * exercised by `test/forge.test.ts` exactly as the layer runs it. The gap is
 * one too, because a test may not wait out a real one.
 */
export const settle = (
  listed: Effect.Effect<ReadonlyArray<PullRequestDetail>, FabrikaError>,
  journal: Journal,
  gap: Duration.Duration,
): Effect.Effect<ReadonlyArray<PullRequestDetail>, FabrikaError> =>
  Effect.gen(function* () {
    const first = yield* listed;
    const pending = first.filter((pr) => pr.merge === "unknown").length;
    if (pending === 0) return first;
    return yield* Effect.gen(function* () {
      const merged = new Map(first.map((pr) => [pr.number, pr] as const));
      for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt += 1) {
        yield* Effect.sleep(gap);
        for (const pr of yield* listed) {
          // A pull request opened between attempts is added; one that flakes
          // back to unknown does not undo an answer we have.
          if (!merged.has(pr.number) || pr.merge !== "unknown") merged.set(pr.number, pr);
        }
        if ([...merged.values()].every((pr) => pr.merge !== "unknown")) break;
      }
      return [...merged.values()];
    }).pipe(waitFor(journal, `merge state of ${pending} pull request(s)`));
  });

export const layer = (options: ForgeOptions) =>
  Layer.effect(Forge)(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { repo, cwd } = options;
      // The reviewer reports itself as a check on the PR. The review loop owns
      // that signal, so waiting for it here would be waiting on the loop's own
      // output — which bot it is stays the reviewer's business, not GitHub's.
      const reviewer = yield* Reviewer;
      const spawned = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
        Effect.provideService(effect, ChildProcessSpawner.ChildProcessSpawner, spawner);
      const gh = (argv: ReadonlyArray<string>) =>
        spawned(run(cwd, ["gh", ...argv])).pipe(Effect.mapError(asFabrikaError(`gh ${argv[0]} ${argv[1] ?? ""}`.trim())));

      // `--limit` is explicit because `gh`'s default of 30 drops pull requests
      // silently; `--base` is deliberately absent, because a stacked pull
      // request has to be listed to be reported.
      const listed = gh([
        "pr", "list", "-R", repo,
        "--author", "@me",
        "--state", "open",
        "--limit", "200",
        "--json", LIST_FIELDS,
      ]).pipe(Effect.flatMap(listing));

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
            ? spawned(exec(cwd, ["gh", "run", "view", "--job", check.job.jobId, "--log-failed", "-R", check.job.repo])).pipe(
                Effect.mapError(asFabrikaError("gh run view")),
                Effect.map((result) => {
                  const lines = result.out.split("\n").filter((line) => line.trim());
                  return lines.slice(-120).join("\n").slice(-8000) || `(no failed-step log; exit ${result.code})`;
                }),
              )
            : Effect.succeed(`(not a CI job with a readable log; see ${check.url})`),

        rerun: (check: Check) =>
          check.job ? gh(["run", "rerun", check.job.id, "--failed", "-R", check.job.repo]).pipe(Effect.asVoid) : Effect.void,

        authored: settle(listed, journal, REFRESH_GAP),
      } satisfies Forge;
    }),
  );
