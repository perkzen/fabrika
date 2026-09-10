import { Duration, Effect } from "effect";
import type { PlatformError } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { run, type ShellFailed } from "./shell.ts";

/**
 * Everything here was read off live PRs (PLAN.md §Cubic), not assumed. The
 * host owns every GitHub write; the agent only decides.
 */
export const BOT = "cubic-dev-ai";

export type Review = { readonly commitId: string; readonly score: number | null; readonly submittedAt: string };

export type Thread = {
  readonly id: string;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
};

export type Decision = { readonly threadId: string; readonly action: "fixed" | "disputed"; readonly reply: string };

export const DECISION_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          action: { type: "string", enum: ["fixed", "disputed"] },
          reply: { type: "string" },
        },
        required: ["threadId", "action", "reply"],
      },
    },
  },
  required: ["decisions"],
});

/** `<!-- cubic:review-summary:confidence-score:5/5 -->`; absent means "not yet", never pass. */
export const parseScore = (body: string): number | null => {
  const m = /confidence-score:(\d+)\/5/.exec(body);
  return m ? Number(m[1]) : null;
};

const gh = (cwd: string, repo: string, args: ReadonlyArray<string>) => run(cwd, ["gh", ...args, "-R", repo]);

const ghJson = <T>(cwd: string, repo: string, args: ReadonlyArray<string>) =>
  gh(cwd, repo, args).pipe(Effect.map((out) => JSON.parse(out) as T));

/** The newest cubic review whose commit is one we pushed this round. */
export const latestReview = (cwd: string, repo: string, pr: number, shas: ReadonlyArray<string>) =>
  ghJson<Array<{ user?: { login?: string }; commit_id: string; body: string; submitted_at: string }>>(cwd, repo, [
    "api",
    // Not --paginate: that concatenates one JSON document per page.
    `repos/${repo}/pulls/${pr}/reviews?per_page=100`,
  ]).pipe(
    Effect.map((reviews) =>
      reviews
        .filter((r) => r.user?.login === `${BOT}[bot]` && shas.includes(r.commit_id))
        .map((r) => ({ commitId: r.commit_id, score: parseScore(r.body), submittedAt: r.submitted_at }) satisfies Review)
        .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
        .at(-1),
    ),
  );

export const waitForReview = (
  cwd: string,
  repo: string,
  pr: number,
  shas: ReadonlyArray<string>,
  timeoutMinutes: number,
  log: (line: string) => Effect.Effect<void>,
): Effect.Effect<Review | undefined, ShellFailed | PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMinutes * 60_000;
    while (true) {
      const review = yield* latestReview(cwd, repo, pr, shas);
      if (review) return review;
      if (Date.now() >= deadline) return undefined;
      yield* log(`waiting for ${BOT} review of ${shas.map((s) => s.slice(0, 7)).join("/")}`);
      yield* Effect.sleep(Duration.seconds(60));
    }
  });

type ThreadsResponse = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: Array<{
            id: string;
            isResolved: boolean;
            isOutdated: boolean;
            path: string;
            line: number | null;
            comments: { nodes: Array<{ author: { login: string } | null; body: string }> };
          }>;
        };
      };
    };
  };
};

/** Unresolved, non-outdated threads opened by the bot. */
export const openThreads = (cwd: string, repo: string, pr: number) => {
  const [owner, name] = repo.split("/");
  const query = `query($owner:String!,$name:String!,$pr:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$pr){
    reviewThreads(first:100){ nodes{ id isResolved isOutdated path line comments(first:1){ nodes{ author{login} body } } } } } } }`;
  return ghJson<ThreadsResponse>(cwd, repo, [
    "api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `pr=${pr}`,
  ]).pipe(
    Effect.map((res) =>
      res.data.repository.pullRequest.reviewThreads.nodes
        .filter((t) => !t.isResolved && !t.isOutdated && (t.comments.nodes[0]?.author?.login ?? "").startsWith(BOT))
        .map((t) => ({ id: t.id, path: t.path, line: t.line, body: t.comments.nodes[0]?.body ?? "" }) satisfies Thread),
    ),
  );
};

export const replyToThread = (cwd: string, repo: string, threadId: string, body: string) =>
  gh(cwd, repo, [
    "api", "graphql",
    "-f", `query=mutation($id:ID!,$body:String!){ addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$body}){ comment{ id } } }`,
    "-f", `id=${threadId}`, "-f", `body=${body}`,
  ]).pipe(Effect.asVoid);

export const resolveThread = (cwd: string, repo: string, threadId: string) =>
  gh(cwd, repo, [
    "api", "graphql",
    "-f", `query=mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id } } }`,
    "-f", `id=${threadId}`,
  ]).pipe(Effect.asVoid);

/** The prompt block the agent sees for one thread; cubic's own agent prompt rides along inside the body. */
export const renderThreads = (threads: ReadonlyArray<Thread>) =>
  threads
    .map((t) => `### thread ${t.id}\nfile: ${t.path}${t.line ? `:${t.line}` : ""}\n\n${t.body.trim()}`)
    .join("\n\n---\n\n");
