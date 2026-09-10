import { Data, Effect, FileSystem, Path } from "effect";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { runClaudeWithFallback, type Credential } from "./claude.ts";
import { CONFIG_PATH, type Config, type Stage } from "./config.ts";
import * as checks from "./checks.ts";
import * as cubic from "./cubic.ts";
import { FabrikaError } from "./errors.ts";
import { runGate, type GateFailure } from "./gate.ts";
import { mcpConfigFile, resolveServers } from "./mcp.ts";
import { run as shRun } from "./shell.ts";
import { asBranchParts, BRANCH_SCHEMA, branchName, defaultParts, type Ticket } from "./ticket.ts";
import * as wt from "./worktree.ts";

export class Escalated extends Data.TaggedError("Escalated")<{
  readonly reason: string;
  readonly worktree: string;
  readonly prUrl?: string;
}> {}

/** Persisted after every step so a dead run resumes rather than restarts. */
type State = {
  sessionId: string | null;
  /** Chosen once by the naming call; a resume must land on the same branch. */
  branch: string | null;
  completed: Array<string>;
  prNumber: number | null;
  round: number;
  pushed: Array<string>;
  /** Actions run ids already rerun once for a suspected flake. */
  reran: Array<string>;
  done: boolean;
};

const PROMPTS = fileURLToPath(new URL("../prompts/", import.meta.url));

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");

const stamp = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

/**
 * `git config user.name` as a branch-safe segment ("Domen Perko" → `domen-perko`),
 * for the `{user}` in the branch pattern: the config is committed to the target
 * repo, so the prefix has to be whoever is running rather than a baked-in name.
 */
const gitUser = (repoRoot: string) =>
  shRun(repoRoot, ["git", "config", "user.name"]).pipe(
    Effect.catchTag("ShellFailed", () => Effect.succeed("")),
    Effect.flatMap((name) => {
      const user = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      return user
        ? Effect.succeed(user)
        : Effect.fail(new FabrikaError({ message: "branch pattern uses {user} but git user.name is unset — set it with `git config user.name`" }));
    }),
  );

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
      : { sessionId: null, branch: null, completed: [], prNumber: null, round: 0, pushed: [], reran: [], done: false };
    state.reran ??= []; // state files from before checks existed
    const save = () => fs.writeFileString(stateFile, JSON.stringify(state, null, 2));
    if (state.done) return yield* log(`already done: ${ticket.identifier} — remove ${runsDir} to rerun`);
    if (state.sessionId) yield* log(`resuming session ${state.sessionId} (${state.completed.join(", ") || "no stages done"})`);

    yield* log(`${ticket.identifier} — ${ticket.title}`);
    // Fail on a missing prompt file or a missing or OAuth-only MCP server now,
    // not after a long install — a config from an older `init` can still name
    // a prompt that no longer ships.
    for (const stage of config.stages) {
      for (const file of [stage.prompt, stage.system]) {
        if (file && !(yield* fs.exists(path.join(PROMPTS, file)))) {
          return yield* new FabrikaError({ message: `stage ${stage.name}: prompts/${file} does not exist — update the stages in ${CONFIG_PATH}` });
        }
      }
      if (stage.mcp?.length) yield* resolveServers(repoRoot, stage.mcp);
    }
    const vars: Record<string, string> = {
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description || "(no description)",
      url_line: ticket.url ? `Link: ${ticket.url}` : "",
      type: ticket.type,
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
      /** Defaults to the worktree; the naming call runs before it exists. */
      cwd?: string;
    }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const mcp = opts.mcp?.length ? yield* mcpConfigFile(yield* resolveServers(repoRoot, opts.mcp)) : undefined;
          const result = yield* runClaudeWithFallback({
            cwd: opts.cwd ?? dir,
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

    // The branch is chosen once. An existing worktree pins it (a state file
    // from before naming existed has no `branch`); otherwise one short
    // structured call applies the `fabrika:branch-naming` skill, and the
    // deterministic parts stand in when the answer breaks the rules.
    if (state.branch === null) {
      if (yield* fs.exists(dir)) {
        state.branch = yield* shRun(dir, ["git", "branch", "--show-current"]);
      } else {
        const named = yield* claude({ stage: "branch", prompt: yield* prompt("branch.md"), jsonSchema: BRANCH_SCHEMA, cwd: repoRoot }).pipe(
          Effect.map((r) => asBranchParts(r.structured)),
          Effect.catchTag("ClaudeFailed", (e) => log(`  naming call failed (${e.message.slice(0, 80)}); using the default name`).pipe(Effect.as(null))),
        );
        if (!named) yield* log(`  naming answer rejected; using the default name`);
        // The namer reads the ticket more carefully than a label regex; its type is the one the stages see.
        if (named) vars.type = named.type;
        const user = config.branch.includes("{user}") ? yield* gitUser(repoRoot) : "";
        state.branch = branchName(config.branch, ticket, named ?? defaultParts(ticket), config.previewPrefix ?? "", user);
      }
      yield* save();
    }
    const branch = state.branch;
    vars.branch = branch;
    yield* log(`branch ${branch} off ${config.base}`);
    yield* wt.create(repoRoot, dir, branch, config.base);
    yield* log(`worktree ${dir}`);

    if (config.install && !(yield* fs.exists(path.join(dir, "node_modules")))) {
      const started = Date.now();
      yield* log(`install: ${config.install}`);
      yield* shRun(dir, ["sh", "-c", config.install]);
      yield* log(`install: ok (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    }

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
    const prUrl = (n: number) => `https://github.com/${repo}/pull/${n}`;
    const workDir = path.join(dir, wt.WORK_DIR);
    /** The stage artifacts outlive the worktree: a human reads them next to the PR. */
    const keepArtifacts = Effect.gen(function* () {
      if (!(yield* fs.exists(workDir))) return;
      const target = path.join(runsDir, "work");
      yield* fs.makeDirectory(target, { recursive: true });
      for (const name of yield* fs.readDirectory(workDir)) {
        yield* fs.copyFile(path.join(workDir, name), path.join(target, name));
      }
      yield* log(`artifacts: ${target}`);
    });

    /**
     * Keeps the branch mergeable while the base moves. Merge, never rebase:
     * pushed commits stay put and cubic's per-commit reviews stay valid.
     * Conflicts go to the agent; the gate runs after any merge. True when
     * HEAD changed.
     */
    const syncWithBase = (prUrlIfAny?: string) =>
      Effect.gen(function* () {
        yield* shRun(dir, ["git", "fetch", "--quiet", remote]);
        const behind = yield* wt.behind(dir, config.base);
        if (behind === 0) return false;
        yield* log(`base moved: ${behind} commit(s) behind ${config.base}; merging`);
        const merged = yield* wt.merge(dir, config.base);
        if (merged.code !== 0) {
          const files = yield* wt.conflictedFiles(dir);
          if (files.length === 0) {
            return yield* new Escalated({ reason: `git merge ${config.base} failed: ${merged.out.trim().slice(-300)}`, worktree: dir, prUrl: prUrlIfAny });
          }
          yield* log(`  ${files.length} conflicted file(s); resolving`);
          yield* claude({
            stage: "merge",
            prompt: yield* prompt("merge.md", { files: files.map((f) => `- ${f}`).join("\n") }),
            systemPromptFile: path.join(PROMPTS, "implement.system.md"),
          });
          const left = yield* wt.conflictedFiles(dir);
          if (left.length > 0) {
            return yield* new Escalated({ reason: `merge of ${config.base} left conflicts in ${left.join(", ")}`, worktree: dir, prUrl: prUrlIfAny });
          }
          if (yield* wt.mergeInProgress(dir)) {
            // Resolved but not committed: same safety net as a dirty stage.
            yield* shRun(dir, ["git", "add", "-A"]);
            yield* shRun(dir, ["git", "commit", "--quiet", "--no-edit"]);
          }
        }
        const failure = yield* gate();
        if (failure) {
          yield* log(`  gate red after merge; one repair pass`);
          yield* claude({ stage: "merge-gate", prompt: gateFeedback(failure), systemPromptFile: path.join(PROMPTS, "implement.system.md") });
          const again = yield* gate();
          if (again) return yield* new Escalated({ reason: `gate red after merging ${config.base}: ${again.name}`, worktree: dir, prUrl: prUrlIfAny });
        }
        return true;
      });

    if (state.prNumber === null) {
      yield* syncWithBase();
      yield* log(`pushing ${commits} commit(s) to ${remote}/${branch}`);
      yield* wt.push(dir, remote, branch);
      state.pushed.push(yield* wt.head(dir));
      // The review stage writes the description; the ticket text is the fallback.
      const prFile = path.join(workDir, "pr.md");
      const description = (yield* fs.exists(prFile)) ? yield* fs.readFileString(prFile) : ticket.description;
      const body = [ticket.url ? `Linear: ${ticket.url}` : "", "", description, "", "---", `Opened by fabrika. Draft until a human reviews.`].join("\n");
      const out = yield* shRun(dir, [
        "gh", "pr", "create", "-R", repo, "--head", branch, "--base", wt.baseBranch(config.base),
        "--title", `${ticket.identifier}: ${ticket.title}`, "--body", body, ...(config.pr.draft ? ["--draft"] : []),
      ]);
      const num = /\/pull\/(\d+)/.exec(out)?.[1];
      if (!num) return yield* new Escalated({ reason: `gh pr create returned no PR URL: ${out}`, worktree: dir });
      state.prNumber = Number(num);
      yield* save();
      yield* log(`PR ${prUrl(state.prNumber)}`);
      if (config.pr.emptyCommit) {
        // Vercel skips a deployment created before the PR existed.
        yield* wt.emptyCommit(dir, "chore: trigger preview deployment");
        yield* wt.push(dir, remote, branch);
        state.pushed.push(yield* wt.head(dir));
        yield* save();
      }
    }
    const prNumber = state.prNumber;

    // Review loop: done means latest cubic score == requireScore, zero open
    // threads, AND zero failing checks on the pushed commit.
    const checksTimeout = config.checks?.timeoutMinutes ?? config.review.timeoutMinutes;
    while (state.round < config.review.maxRounds) {
      state.round += 1;
      yield* save();
      yield* log(`review round ${state.round}/${config.review.maxRounds}`);
      if (yield* syncWithBase(prUrl(prNumber))) {
        yield* wt.push(dir, remote, branch);
        state.pushed = [yield* wt.head(dir)];
        yield* save();
      }
      const review = yield* cubic.waitForReview(dir, repo, prNumber, state.pushed, config.review.timeoutMinutes, log);
      if (!review) return yield* new Escalated({ reason: `no cubic review within ${config.review.timeoutMinutes} min`, worktree: dir, prUrl: prUrl(prNumber) });
      const threads = yield* cubic.openThreads(dir, repo, prNumber);
      const pushedHead = state.pushed.at(-1)!;
      const waitChecks = () =>
        checks.waitForChecks(dir, repo, prNumber, pushedHead, checksTimeout, log).pipe(
          Effect.flatMap((all) =>
            all
              ? Effect.succeed(all.filter((c) => c.bucket === "fail"))
              : new Escalated({ reason: `checks still pending after ${checksTimeout} min`, worktree: dir, prUrl: prUrl(prNumber) }),
          ),
        );
      let failed = yield* waitChecks();
      // One rerun per Actions run, for flakes; a failure that survives it is the agent's.
      const flaky = failed.filter((c) => c.run && !state.reran.includes(c.run.id));
      if (flaky.length > 0) {
        for (const c of flaky) {
          yield* checks.rerunFailed(dir, c);
          state.reran.push(c.run!.id);
        }
        yield* save();
        yield* log(`  reran ${flaky.length} failed run(s) once in case of flakes`);
        failed = yield* waitChecks();
      }
      yield* log(`  score ${review.score ?? "none"}/5, ${threads.length} open thread(s), ${failed.length} failing check(s)`);
      const scoreOk = review.score !== null && review.score >= config.review.requireScore;
      if (scoreOk && threads.length === 0 && failed.length === 0) {
        state.done = true;
        yield* save();
        yield* keepArtifacts;
        yield* wt.remove(repoRoot, dir);
        yield* log(`done: cubic ${review.score}/5, no open threads, checks green — ready for human review: ${prUrl(prNumber)}`);
        return;
      }
      if (threads.length === 0 && failed.length === 0) {
        // Nothing the agent can act on, and the same review would be found again next loop.
        return yield* new Escalated({
          reason: `cubic score ${review.score ?? "missing"}/5 with no open threads or failing checks to act on`,
          worktree: dir,
          prUrl: prUrl(prNumber),
        });
      }

      const before = yield* wt.head(dir);
      let decisions: Array<cubic.Decision> = [];
      if (threads.length > 0) {
        const result = yield* claude({
          stage: "cubic",
          prompt: yield* prompt("cubic.md", { count: String(threads.length), threads: cubic.renderThreads(threads) }),
          systemPromptFile: path.join(PROMPTS, "cubic.system.md"),
          jsonSchema: cubic.DECISION_SCHEMA,
        });
        decisions = ((result.structured as { decisions?: Array<cubic.Decision> } | undefined)?.decisions ?? []).filter(
          (d) => threads.some((t) => t.id === d.threadId),
        );
        if (yield* wt.isDirty(dir)) {
          yield* shRun(dir, ["git", "add", "-A"]);
          yield* shRun(dir, ["git", "commit", "--quiet", "-m", "review: address cubic findings"]);
        }
      }
      if (failed.length > 0) {
        const failures: Array<{ check: checks.Check; log: string }> = [];
        for (const check of failed) failures.push({ check, log: yield* checks.failedLog(dir, check) });
        yield* claude({
          stage: "ci",
          prompt: yield* prompt("ci.md", { count: String(failed.length), sha: pushedHead.slice(0, 7), failures: checks.renderFailures(failures) }),
          systemPromptFile: path.join(PROMPTS, "implement.system.md"),
        });
        if (yield* wt.isDirty(dir)) {
          yield* shRun(dir, ["git", "add", "-A"]);
          yield* shRun(dir, ["git", "commit", "--quiet", "-m", "fix(ci): address failing checks"]);
        }
      }
      const failure = yield* gate();
      if (failure) {
        yield* log(`  gate red after review fixes; one repair pass`);
        yield* claude({ stage: "cubic-gate", prompt: gateFeedback(failure), systemPromptFile: path.join(PROMPTS, "implement.system.md") });
        const again = yield* gate();
        if (again) return yield* new Escalated({ reason: `gate red after cubic round ${state.round}: ${again.name}`, worktree: dir, prUrl: prUrl(prNumber) });
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
    return yield* new Escalated({ reason: `not clean after ${config.review.maxRounds} review rounds`, worktree: dir, prUrl: prUrl(prNumber) });
  });
