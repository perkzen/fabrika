import { Duration, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { asFabrikaError, FabrikaError } from "../errors.ts";
import { exec, run } from "../infra/shell.ts";
import { Forge, type Check, type CheckState, type NewPullRequest } from "../ports/forge.ts";
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

/**
 * `gh pr create --attach` arrived in 2.99.0. An older `gh` handed an unknown
 * flag fails the whole create, and a capture may never fail a run.
 */
export const attachesFrom = (version: string): boolean => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 2 || (major === 2 && minor >= 99);
};

/**
 * The body goes in a file rather than an argument — it has no length limit
 * there — and each attachment is matched to the body by its absolute path, so
 * the paths passed here are the paths the body must already carry.
 */
export const createArgs = (repo: string, base: string, input: NewPullRequest, bodyFile: string): ReadonlyArray<string> => [
  "pr", "create", "-R", repo,
  "--head", input.branch,
  "--base", base,
  "--title", input.title,
  "--body-file", bodyFile,
  ...(input.draft ? ["--draft"] : []),
  ...input.attachments.flatMap((path) => ["--attach", path]),
];

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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
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

      let attaches: boolean | undefined;

      /**
       * A pull request body reaches `gh` through a file, never an argument:
       * a body has no length limit there, and `--attach` matches an image to
       * the body by a path an argv-length limit would truncate.
       */
      const withBodyFile = <A, E>(body: string, use: (file: string) => Effect.Effect<A, E>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const dir = yield* fs
              .makeTempDirectoryScoped({ prefix: "fabrika-pr-" })
              .pipe(Effect.mapError(asFabrikaError("pr body file")));
            const file = path.join(dir, "body.md");
            yield* fs.writeFileString(file, body).pipe(Effect.mapError(asFabrikaError("pr body file")));
            return yield* use(file);
          }),
        );

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
          withBodyFile(input.body, (bodyFile) =>
            Effect.gen(function* () {
              const out = yield* gh(createArgs(repo, options.base, input, bodyFile));
              const number = /\/pull\/(\d+)/.exec(out)?.[1];
              return number
                ? { number: Number(number), url: `https://github.com/${repo}/pull/${number}` }
                : yield* Effect.fail(new FabrikaError({ message: `gh pr create returned no PR URL: ${out}` }));
            }),
          ),

        // Read once: every body in a run is posted by the same `gh`.
        attaches: Effect.suspend(() => {
          if (attaches !== undefined) return Effect.succeed(attaches);
          return gh(["--version"]).pipe(
            Effect.orElseSucceed(() => ""),
            Effect.tap((version) =>
              attachesFrom(version)
                ? Effect.void
                : journal.log(`captures: images left out — ${version.split("\n")[0] || "gh"} has no --attach`),
            ),
            Effect.map((version) => (attaches = attachesFrom(version))),
          );
        }),

        body: (pr: number) => gh(["pr", "view", String(pr), "-R", repo, "--json", "body", "--jq", ".body"]),

        editBody: (pr: number, body: string) =>
          withBodyFile(body, (bodyFile) =>
            gh(["pr", "edit", String(pr), "-R", repo, "--body-file", bodyFile]).pipe(Effect.asVoid),
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
      } satisfies Forge;
    }),
  );
