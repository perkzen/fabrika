import { Duration, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { asFabrikaError } from "../errors.ts";
import { run } from "../infra/shell.ts";
import { Journal } from "../ports/journal.ts";
import { Reviewer, type Review, type ReviewThread } from "../ports/reviewer.ts";
import { Workspace } from "../ports/workspace.ts";

/**
 * cubic, read through `gh`. Everything here was read off live cubic-reviewed
 * PRs, not assumed: the score lives in an HTML comment in the review body,
 * and the findings are ordinary pull request review threads.
 *
 * The host owns every GitHub write. The agent decides what to say about a
 * thread; posting the reply and resolving it happen here.
 */
export const BOT = "cubic-dev-ai";

const POLL = Duration.seconds(60);

/** `<!-- cubic:review-summary:confidence-score:5/5 -->`; absent means "not yet", never pass. */
export const parseScore = (body: string): number | null => {
  const match = /confidence-score:(\d+)\/5/.exec(body);
  return match ? Number(match[1]) : null;
};

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

export const layer = Layer.effect(Reviewer)(
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const journal = yield* Journal;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const repo = yield* workspace.githubRepo;
    const [owner, name] = repo.split("/");

    const gh = (argv: ReadonlyArray<string>) =>
      Effect.provideService(
        run(workspace.dir, ["gh", ...argv, "-R", repo]),
        ChildProcessSpawner.ChildProcessSpawner,
        spawner,
      ).pipe(Effect.mapError(asFabrikaError(`gh ${argv[0]}`)));
    const ghJson = <T>(argv: ReadonlyArray<string>) => gh(argv).pipe(Effect.map((out) => JSON.parse(out) as T));

    /** Unresolved, non-outdated threads opened by the bot. */
    const openThreads = (pr: number) => {
      const query = `query($owner:String!,$name:String!,$pr:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$pr){
    reviewThreads(first:100){ nodes{ id isResolved isOutdated path line comments(first:1){ nodes{ author{login} body } } } } } } }`;
      return ghJson<ThreadsResponse>([
        "api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `pr=${pr}`,
      ]).pipe(
        Effect.map((response) =>
          response.data.repository.pullRequest.reviewThreads.nodes
            .filter(
              (thread) =>
                !thread.isResolved && !thread.isOutdated && (thread.comments.nodes[0]?.author?.login ?? "").startsWith(BOT),
            )
            .map(
              (thread) =>
                ({
                  id: thread.id,
                  path: thread.path,
                  line: thread.line,
                  body: thread.comments.nodes[0]?.body ?? "",
                }) satisfies ReviewThread,
            ),
        ),
      );
    };

    /** The newest review whose commit is one we pushed this round. */
    const latest = (pr: number, commits: ReadonlyArray<string>) =>
      ghJson<Array<{ user?: { login?: string }; commit_id: string; body: string; submitted_at: string }>>([
        "api",
        // Not --paginate: that concatenates one JSON document per page.
        `repos/${repo}/pulls/${pr}/reviews?per_page=100`,
      ]).pipe(
        Effect.map((reviews) =>
          reviews
            .filter((review) => review.user?.login === `${BOT}[bot]` && commits.includes(review.commit_id))
            .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))
            .at(-1),
        ),
      );

    const mutation = (query: string, fields: ReadonlyArray<string>) =>
      gh(["api", "graphql", "-f", `query=${query}`, ...fields.flatMap((field) => ["-f", field])]).pipe(Effect.asVoid);

    return {
      name: "cubic",
      owns: (checkName: string, checkUrl: string) => /cubic/i.test(checkName) || checkUrl.includes("cubic.dev"),
      decisionSchema: DECISION_SCHEMA,
      prompts: { threads: "cubic.md", system: "cubic.system.md" },

      // One wait for the whole poll loop, not a line per poll: the
      // repetition an operator needs is the presenter's job now, which is
      // what lets a terminal animate it and a pipe heartbeat it.
      await: (pr: number, commits: ReadonlyArray<string>, timeoutMinutes: number) => {
        const subject = `${BOT} review of ${commits.map((sha) => sha.slice(0, 7)).join("/")}`;
        let started = Date.now();
        return Effect.gen(function* () {
          started = Date.now();
          yield* journal.log({ kind: "wait", state: "start", subject, deadlineMinutes: timeoutMinutes });
          const deadline = started + timeoutMinutes * 60_000;
          while (true) {
            const review = yield* latest(pr, commits);
            if (review) {
              return {
                commit: review.commit_id,
                score: parseScore(review.body),
                threads: yield* openThreads(pr),
              } satisfies Review;
            }
            if (Date.now() >= deadline) return undefined;
            yield* Effect.sleep(POLL);
          }
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              journal.log({ kind: "wait", state: "end", subject, seconds: (Date.now() - started) / 1000 }),
            ),
          ),
        );
      },

      reply: (threadId: string, body: string) =>
        mutation(
          `mutation($id:ID!,$body:String!){ addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$body}){ comment{ id } } }`,
          [`id=${threadId}`, `body=${body}`],
        ),

      resolve: (threadId: string) =>
        mutation(`mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id } } }`, [`id=${threadId}`]),

      /** cubic's own agent prompt rides along inside the body, so it is passed through whole. */
      renderThreads: (threads: ReadonlyArray<ReviewThread>) =>
        threads
          .map((thread) => `### thread ${thread.id}\nfile: ${thread.path}${thread.line ? `:${thread.line}` : ""}\n\n${thread.body.trim()}`)
          .join("\n\n---\n\n"),
    } satisfies Reviewer;
  }),
);
