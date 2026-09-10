import { Data, Effect, FileSystem, Path } from "effect";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { runClaudeWithFallback, type Credential } from "./claude.ts";
import { type Config, type Stage } from "./config.ts";
import * as cubic from "./cubic.ts";
import { FabrikaError } from "./errors.ts";
import { runGate, type GateFailure } from "./gate.ts";
import { mcpConfigFile, resolveServers } from "./mcp.ts";
import { run as shRun } from "./shell.ts";
import { branchName, type Ticket } from "./ticket.ts";
import * as wt from "./worktree.ts";

export class Escalated extends Data.TaggedError("Escalated")<{
  readonly reason: string;
  readonly worktree: string;
  readonly prNumber?: number;
}> {}

/** Persisted after every step so a dead run resumes rather than restarts. */
type State = {
  sessionId: string | null;
  completed: Array<string>;
  prNumber: number | null;
  round: number;
  pushed: Array<string>;
  done: boolean;
};

const PROMPTS = new URL("../prompts/", import.meta.url).pathname;

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");

const stamp = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

/** `owner/repo` from the remote URL, for `-R` on every gh call: the monorepo has two remotes. */
const githubRepo = (repoRoot: string, remote: string) =>
  shRun(repoRoot, ["git", "remote", "get-url", remote]).pipe(
    Effect.flatMap((url) => {
      const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url);
      return m ? Effect.succeed(m[1]!) : Effect.fail(new FabrikaError({ message: `remote ${remote} is not a GitHub URL: ${url}` }));
    }),
  );

export const runTicket = (config: Config, ticket: Ticket, credentials: ReadonlyArray<Credential>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = process.cwd();
    const branch = branchName(config.branch, ticket);
    const dir = yield* wt.worktreePath(repoRoot, ticket.identifier);
    const runsDir = path.join(homedir(), ".fabrika", "runs", path.basename(repoRoot), ticket.identifier);
    const stateFile = path.join(runsDir, "state.json");
    yield* fs.makeDirectory(runsDir, { recursive: true });

    // Synchronous on purpose: the stream-json callback in claude.ts is a plain function.
    const logSync = (line: string) => {
      const stamped = `${stamp()} ${line}`;
      console.log(stamped);
      try {
        appendFileSync(path.join(runsDir, "log.txt"), stamped + "\n");
      } catch {}
    };
    const log = (line: string) => Effect.sync(() => logSync(line));

    const state: State = (yield* fs.exists(stateFile))
      ? (JSON.parse(yield* fs.readFileString(stateFile)) as State)
      : { sessionId: null, completed: [], prNumber: null, round: 0, pushed: [], done: false };
    const save = () => fs.writeFileString(stateFile, JSON.stringify(state, null, 2));
    if (state.done) return yield* log(`already done: ${ticket.identifier} — remove ${runsDir} to rerun`);
    if (state.sessionId) yield* log(`resuming session ${state.sessionId} (${state.completed.join(", ") || "no stages done"})`);

    yield* log(`${ticket.identifier} — ${ticket.title}`);
    // Fail on a missing or OAuth-only MCP server now, not after a long install.
    for (const stage of config.stages) if (stage.mcp?.length) yield* resolveServers(repoRoot, stage.mcp);
    yield* log(`branch ${branch} off ${config.base}`);
    yield* wt.create(repoRoot, dir, branch, config.base);
    yield* log(`worktree ${dir}`);

    if (config.install && !(yield* fs.exists(path.join(dir, "node_modules")))) {
      const started = Date.now();
      yield* log(`install: ${config.install}`);
      yield* shRun(dir, ["sh", "-c", config.install]);
      yield* log(`install: ok (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    }

    const vars = {
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description || "(no description)",
      url_line: ticket.url ? `Link: ${ticket.url}` : "",
      branch,
      base: config.base,
    };
    const prompt = (file: string, extra: Record<string, string> = {}) =>
      fs.readFileString(path.join(PROMPTS, file)).pipe(Effect.map((t) => fill(t, { ...vars, ...extra })));

    let counter = 0;
    const claude = (opts: {
      stage: string;
      prompt: string;
      systemPromptFile?: string;
      mcp?: ReadonlyArray<string>;
      jsonSchema?: string;
    }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const mcp = opts.mcp?.length ? yield* mcpConfigFile(yield* resolveServers(repoRoot, opts.mcp)) : undefined;
          const result = yield* runClaudeWithFallback({
            cwd: dir,
            prompt: opts.prompt,
            credentials,
            resume: state.sessionId,
            systemPromptFile: opts.systemPromptFile,
            mcpConfigFile: mcp,
            disallowedTools: config.deny,
            jsonSchema: opts.jsonSchema,
            rawLog: path.join(runsDir, `${opts.stage}-${++counter}.jsonl`),
            onLine: (line) => logSync(`  ${line.slice(0, 400).replace(/\n/g, " ")}`),
          });
          state.sessionId = result.sessionId ?? state.sessionId;
          yield* save();
          if (result.costUsd !== null) yield* log(`  (${opts.stage}: $${result.costUsd.toFixed(2)})`);
          return result;
        }),
      );

    const gateFeedback = (f: GateFailure) =>
      `The host-run gate failed at step "${f.name}" (${f.command}). Fix it, commit, and stop.\n\nOutput (tail):\n\n${f.output}`;

    const gate = () =>
      Effect.gen(function* () {
        const changed = yield* wt.changedFiles(dir, config.base);
        return yield* runGate(dir, config.gate, changed, log);
      });

    /** One stage: run, then gate-and-feed-back up to maxIterations. */
    const runStage = (stage: Stage) =>
      Effect.gen(function* () {
        const systemPromptFile = stage.system ? path.join(PROMPTS, stage.system) : undefined;
        let next = yield* prompt(stage.prompt);
        for (let i = 1; i <= config.maxIterations; i++) {
          yield* log(`stage ${stage.name} (${i}/${config.maxIterations})`);
          yield* claude({ stage: stage.name, prompt: next, systemPromptFile, mcp: stage.mcp });
          if (yield* wt.isDirty(dir)) {
            yield* log(`  worktree dirty after ${stage.name}; committing leftovers`);
            yield* shRun(dir, ["git", "add", "-A"]);
            yield* shRun(dir, ["git", "commit", "--quiet", "-m", `${stage.name}: uncommitted changes`]);
          }
          if (!stage.gate) return;
          const failure = yield* gate();
          if (!failure) return;
          next = gateFeedback(failure);
        }
        return yield* new Escalated({ reason: `stage ${stage.name}: gate still red after ${config.maxIterations} iterations`, worktree: dir });
      });

    for (const stage of config.stages) {
      if (state.completed.includes(stage.name)) {
        yield* log(`stage ${stage.name}: already done`);
        continue;
      }
      yield* runStage(stage);
      state.completed.push(stage.name);
      yield* save();
    }

    const commits = yield* wt.commitCount(dir, config.base);
    if (commits === 0) return yield* new Escalated({ reason: "no commits after all stages", worktree: dir });

    const remote = wt.remoteOf(config.base);
    const repo = yield* githubRepo(repoRoot, remote);

    if (state.prNumber === null) {
      yield* log(`pushing ${commits} commit(s) to ${remote}/${branch}`);
      yield* wt.push(dir, remote, branch);
      state.pushed.push(yield* wt.head(dir));
      const body = [ticket.url ? `Linear: ${ticket.url}` : "", "", ticket.description, "", "---", `Opened by fabrika. Draft until a human reviews.`].join("\n");
      const out = yield* shRun(dir, [
        "gh", "pr", "create", "-R", repo, "--head", branch, "--base", wt.baseBranch(config.base),
        "--title", `${ticket.identifier}: ${ticket.title}`, "--body", body, ...(config.pr.draft ? ["--draft"] : []),
      ]);
      const num = /\/pull\/(\d+)/.exec(out)?.[1];
      if (!num) return yield* new Escalated({ reason: `gh pr create returned no PR URL: ${out}`, worktree: dir });
      state.prNumber = Number(num);
      yield* save();
      yield* log(`PR #${state.prNumber} ${out.trim()}`);
      if (config.pr.emptyCommit) {
        // Vercel skips a deployment created before the PR existed.
        yield* wt.emptyCommit(dir, "chore: trigger preview deployment");
        yield* wt.push(dir, remote, branch);
        state.pushed.push(yield* wt.head(dir));
        yield* save();
      }
    }
    const prNumber = state.prNumber;

    // Cubic loop: done means latest score == requireScore AND zero open threads.
    while (state.round < config.review.maxRounds) {
      state.round += 1;
      yield* save();
      yield* log(`review round ${state.round}/${config.review.maxRounds}`);
      const review = yield* cubic.waitForReview(dir, repo, prNumber, state.pushed, config.review.timeoutMinutes, log);
      if (!review) return yield* new Escalated({ reason: `no cubic review within ${config.review.timeoutMinutes} min`, worktree: dir, prNumber });
      const threads = yield* cubic.openThreads(dir, repo, prNumber);
      yield* log(`  score ${review.score ?? "none"}/5, ${threads.length} open thread(s)`);
      if (review.score !== null && review.score >= config.review.requireScore && threads.length === 0) {
        state.done = true;
        yield* save();
        yield* log(`done: PR #${prNumber} is clean; removing worktree`);
        yield* wt.remove(repoRoot, dir);
        return;
      }
      if (threads.length === 0) {
        // Nothing the agent can act on, and the same review would be found again next loop.
        return yield* new Escalated({
          reason: `cubic score ${review.score ?? "missing"}/5 on PR #${prNumber} with no open threads to act on`,
          worktree: dir,
          prNumber,
        });
      }

      const before = yield* wt.head(dir);
      const result = yield* claude({
        stage: "cubic",
        prompt: yield* prompt("cubic.md", { count: String(threads.length), threads: cubic.renderThreads(threads) }),
        systemPromptFile: path.join(PROMPTS, "cubic.system.md"),
        jsonSchema: cubic.DECISION_SCHEMA,
      });
      const decisions = ((result.structured as { decisions?: Array<cubic.Decision> } | undefined)?.decisions ?? []).filter(
        (d) => threads.some((t) => t.id === d.threadId),
      );
      if (yield* wt.isDirty(dir)) {
        yield* shRun(dir, ["git", "add", "-A"]);
        yield* shRun(dir, ["git", "commit", "--quiet", "-m", "review: address cubic findings"]);
      }
      const failure = yield* gate();
      if (failure) {
        yield* log(`  gate red after review fixes; one repair pass`);
        yield* claude({ stage: "cubic-gate", prompt: gateFeedback(failure), systemPromptFile: path.join(PROMPTS, "implement.system.md") });
        const again = yield* gate();
        if (again) return yield* new Escalated({ reason: `gate red after cubic round ${state.round}: ${again.name}`, worktree: dir, prNumber });
      }
      const touched = yield* wt.filesSince(dir, before);
      if ((yield* wt.head(dir)) !== before) {
        yield* wt.push(dir, remote, branch);
        state.pushed = [yield* wt.head(dir)];
        yield* save();
      }
      for (const d of decisions) {
        const thread = threads.find((t) => t.id === d.threadId)!;
        yield* cubic.replyToThread(dir, repo, d.threadId, d.reply);
        // Resolve only under the two conditions; a "fixed" with no commit on that path stays open.
        const mayResolve = d.action === "disputed" || touched.includes(thread.path);
        yield* log(`  ${d.action} ${thread.path}${mayResolve ? "" : " — left open: no commit touched it"}`);
        if (mayResolve) yield* cubic.resolveThread(dir, repo, d.threadId);
      }
    }
    return yield* new Escalated({ reason: `not clean after ${config.review.maxRounds} review rounds`, worktree: dir, prNumber });
  });
