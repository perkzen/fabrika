import { Duration, Effect } from "effect";
import { exec, run } from "./shell.ts";

/**
 * The PR's checks, read off `gh pr view --json headRefOid,statusCheckRollup`
 * (shapes read off live PRs 2026-09-10). Two kinds arrive: `CheckRun`
 * (GitHub Actions and apps) and `StatusContext` (commit statuses, e.g.
 * Vercel). The head sha comes with them, so a caller can tell "the checks of
 * the commit I just pushed" from "the checks of the one before".
 */
export type Bucket = "pass" | "fail" | "pending";

export type Check = {
  readonly name: string;
  readonly url: string;
  readonly bucket: Bucket;
  /** `owner/repo` and run id when the check is a GitHub Actions job; the run may live in a differently named repo than the PR. */
  readonly run?: { readonly repo: string; readonly id: string; readonly jobId: string };
};

type Rollup = {
  headRefOid: string;
  statusCheckRollup: Array<
    | { __typename: "CheckRun"; name: string; status: string; conclusion: string; detailsUrl: string; workflowName: string }
    | { __typename: "StatusContext"; context: string; state: string; targetUrl: string }
  >;
};

const GOOD = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/** cubic reports itself as a check run; the review loop owns that signal. */
const isReviewer = (name: string, url: string) => /cubic/i.test(name) || url.includes("cubic.dev");

const actionsJob = (url: string) => {
  const m = /github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(url);
  return m ? { repo: m[1]!, id: m[2]!, jobId: m[3]! } : undefined;
};

export const classify = (rollup: Rollup["statusCheckRollup"]): Array<Check> =>
  rollup.flatMap((c) => {
    if (c.__typename === "StatusContext") {
      if (isReviewer(c.context, c.targetUrl)) return [];
      const bucket: Bucket = c.state === "SUCCESS" ? "pass" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "fail";
      return [{ name: c.context, url: c.targetUrl, bucket }];
    }
    if (isReviewer(c.name, c.detailsUrl)) return [];
    const bucket: Bucket = c.status !== "COMPLETED" ? "pending" : GOOD.has(c.conclusion) ? "pass" : "fail";
    const run = actionsJob(c.detailsUrl);
    return [{ name: c.workflowName ? `${c.workflowName} / ${c.name}` : c.name, url: c.detailsUrl, bucket, ...(run ? { run } : {}) }];
  });

export const checks = (cwd: string, repo: string, pr: number) =>
  run(cwd, ["gh", "pr", "view", String(pr), "-R", repo, "--json", "headRefOid,statusCheckRollup"]).pipe(
    Effect.map((out) => {
      const r = JSON.parse(out) as Rollup;
      return { sha: r.headRefOid, checks: classify(r.statusCheckRollup) };
    }),
  );

/**
 * The checks of `sha` once none is pending. A rollup can be empty for a
 * moment after a push (nothing registered yet) — or forever, in a repo with
 * no CI — so an empty list is accepted only after a short grace period.
 * `undefined` on timeout.
 */
export const waitForChecks = (
  cwd: string,
  repo: string,
  pr: number,
  sha: string,
  timeoutMinutes: number,
  log: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const started = Date.now();
    const deadline = started + timeoutMinutes * 60_000;
    while (true) {
      const r = yield* checks(cwd, repo, pr);
      const settled = r.sha === sha && r.checks.every((c) => c.bucket !== "pending");
      const graceOver = Date.now() - started > 2 * 60_000;
      if (settled && (r.checks.length > 0 || graceOver)) return r.checks;
      if (Date.now() >= deadline) return undefined;
      const pending = r.checks.filter((c) => c.bucket === "pending").length;
      yield* log(`waiting for checks on ${sha.slice(0, 7)} (${r.sha === sha ? `${pending} pending` : "head not updated yet"})`);
      yield* Effect.sleep(Duration.seconds(60));
    }
  });

/** Failed steps' log for an Actions job, tail only; other checks carry just their link. */
export const failedLog = (cwd: string, check: Check) =>
  check.run
    ? exec(cwd, ["gh", "run", "view", "--job", check.run.jobId, "--log-failed", "-R", check.run.repo]).pipe(
        Effect.map((r) => {
          const lines = r.out.split("\n").filter((l) => l.trim());
          return lines.slice(-120).join("\n").slice(-8000) || `(no failed-step log; exit ${r.code})`;
        }),
      )
    : Effect.succeed(`(not a GitHub Actions job; see ${check.url})`);

/** One retry for flakes; the caller records the run id so it happens once. */
export const rerunFailed = (cwd: string, check: Check) =>
  check.run ? run(cwd, ["gh", "run", "rerun", check.run.id, "--failed", "-R", check.run.repo]).pipe(Effect.asVoid) : Effect.void;

export const renderFailures = (failures: ReadonlyArray<{ check: Check; log: string }>) =>
  failures.map(({ check, log }) => `### ${check.name}\n${check.url}\n\n\`\`\`\n${log}\n\`\`\``).join("\n\n");
