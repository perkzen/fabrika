/**
 * Wraps the Claude Code CLI as a subprocess.
 *
 * The credential contract is the whole point: we spawn the real `claude`
 * binary and never read, mint or replay its OAuth credentials. An empty
 * `env` means "use whatever this machine is logged in as".
 *
 * `--bare` is deliberately absent — bare mode never reads the subscription
 * login and would demand an API key. The cost of that is auto-discovery of
 * the target repo's MCP servers, which `--strict-mcp-config` turns back off.
 *
 * fabrika's own skills ride along as a plugin (`skills/`, manifest in
 * `.claude-plugin/`) via `--plugin-dir`, so a stage prompt can name
 * `fabrika:tdd` in any target repo. Verified on 2.1.267: the init event lists
 * the plugin and its skills, and the model invokes them through the Skill
 * tool in `-p` mode. The flag is per invocation, so it goes on every call,
 * resumed ones included.
 */
import { Effect, Fiber, FileSystem, Stream } from "effect";
import type { PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { AgentFailed, AgentRateLimited, AgentUnauthorized } from "../ports/agent.ts";
import { PLUGIN_DIR } from "../paths.ts";
import type { RunEvent } from "../run-event.ts";
import { describeContent, type ContentBlock } from "./transcript.ts";

export type Credential = {
  readonly name: string;
  readonly env: Record<string, string>;
};

export type ClaudeError = AgentUnauthorized | AgentRateLimited | AgentFailed | PlatformError.PlatformError;

export type ClaudeResult = {
  readonly sessionId: string | null;
  /**
   * Skill names the session *loaded*, from the init event (e.g. `fabrika:tdd`).
   * Read by `scripts/smoke.ts` and nowhere else, and never journalled: it is
   * the same plugin list every time, so it tells an operator nothing. What a
   * step actually reached for is read off its `Skill` tool calls instead.
   */
  readonly loadedSkills: ReadonlyArray<string>;
  readonly text: string;
  /** Parsed `structured_output` when the run used `jsonSchema`. */
  readonly structured: unknown;
  readonly costUsd: number | null;
};

export type ClaudeOptions = {
  readonly cwd: string;
  readonly prompt: string;
  readonly credential: Credential;
  readonly resume?: string | null;
  readonly model?: string;
  /** `--append-system-prompt-file`: persistent role identity for a stage. */
  readonly systemPromptFile?: string;
  /** Path to a JSON file with only the MCP servers this stage may use. */
  readonly mcpConfigFile?: string;
  /** Permission-rule strings, e.g. `Bash(git push:*)`. */
  readonly disallowedTools?: ReadonlyArray<string>;
  /** JSON Schema string; the result arrives in `structured`. */
  readonly jsonSchema?: string;
  /** Every raw stream-json line is appended here, for post-mortems. */
  readonly rawLog?: string;
  /** Which unit of work these events belong to; it rides on every agent and tool event. */
  readonly stage?: string;
  readonly onEvent?: (event: RunEvent) => void;
};

type StreamEvent = {
  type?: string;
  subtype?: string;
  error?: string;
  session_id?: string;
  skills?: Array<string>;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  message?: { content?: Array<ContentBlock> };
};

const RATE_LIMITED = new Set(["rate_limit", "account_on_hold", "billing_error"]);
const AUTH_FAILED = new Set(["authentication_failed", "oauth_org_not_allowed"]);

type RunState = {
  sessionId: string | null;
  loadedSkills: Array<string>;
  text: string;
  structured: unknown;
  isError: boolean;
  costUsd: number | null;
  sawRateLimit: boolean;
  authFailed: boolean;
};

export const runClaude = (
  opts: ClaudeOptions,
): Effect.Effect<ClaudeResult, ClaudeError, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const args: Array<string> = [
      "-p",
      opts.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      // Under -p there is no prompt path: a gated tool call is denied, not
      // asked. The deny list is what keeps this from being a blank cheque.
      "--dangerously-skip-permissions",
      "--plugin-dir",
      PLUGIN_DIR,
      "--strict-mcp-config",
      "--mcp-config",
      // A bare `{}` is rejected on 2.1.241; the record itself must be present.
      opts.mcpConfigFile ?? '{"mcpServers":{}}',
    ];
    if (opts.model) args.push("--model", opts.model);
    if (opts.resume) args.push("--resume", opts.resume);
    if (opts.systemPromptFile) args.push("--append-system-prompt-file", opts.systemPromptFile);
    if (opts.disallowedTools?.length) args.push("--disallowedTools", ...opts.disallowedTools);
    if (opts.jsonSchema) args.push("--json-schema", opts.jsonSchema);

    // Never inherit a parent Claude Code session's plumbing (nested-session
    // guard, messaging socket, session ids). This also drops a CLAUDE_CONFIG_DIR
    // set in the shell — deliberately: which account a run uses is decided by
    // `Credential.env`, applied after the strip, never by ambient environment.
    // `extendEnv` stays false so the stripped copy below is the whole
    // environment; setting it true would merge the CLAUDE* vars straight back.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^CLAUDE/.test(key)) env[key] = value;
    }
    Object.assign(env, opts.credential.env);

    const command = ChildProcess.make("claude", args, {
      cwd: opts.cwd,
      env,
      extendEnv: false,
      // Stated rather than inherited: a key the operator presses at the screen
      // must never reach the agent's input, and a release candidate's default
      // can move.
      stdin: "ignore",
    });

    const state: RunState = {
      sessionId: opts.resume ?? null,
      loadedSkills: [],
      text: "",
      structured: undefined,
      isError: false,
      costUsd: null,
      sawRateLimit: false,
      authFailed: false,
    };

    const consume = (line: string) =>
      Effect.gen(function* () {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (opts.rawLog) yield* fs.writeFileString(opts.rawLog, trimmed + "\n", { flag: "a" });
        interpret(trimmed, state, opts);
      });

    const { exitCode, stderr } = yield* Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const proc = yield* spawner.spawn(command);
        const stderrFiber = yield* proc.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkChild);
        yield* proc.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach(consume));
        const exitCode = yield* proc.exitCode;
        const stderr = yield* Fiber.join(stderrFiber);
        return { exitCode: Number(exitCode), stderr };
      }),
    );

    if (state.authFailed) {
      return yield* new AgentUnauthorized({
        credential: opts.credential.name,
        sessionId: state.sessionId,
        message: state.text || stderr.trim(),
      });
    }
    if (state.sawRateLimit) {
      return yield* new AgentRateLimited({ credential: opts.credential.name, sessionId: state.sessionId });
    }
    if (exitCode !== 0 || state.isError) {
      return yield* new AgentFailed({
        exitCode,
        sessionId: state.sessionId,
        message: state.text || stderr.trim(),
      });
    }

    return {
      sessionId: state.sessionId,
      loadedSkills: state.loadedSkills,
      text: state.text,
      structured: state.structured,
      costUsd: state.costUsd,
    };
  });

function interpret(line: string, state: RunState, opts: ClaudeOptions) {
  let event: StreamEvent;
  try {
    event = JSON.parse(line) as StreamEvent;
  } catch {
    return;
  }

  if (event.session_id) state.sessionId = event.session_id;

  if (event.type === "system" && event.subtype === "init") {
    state.loadedSkills = event.skills ?? [];
    return;
  }

  if (event.type === "system" && event.subtype === "api_retry") {
    if (event.error && RATE_LIMITED.has(event.error)) state.sawRateLimit = true;
    if (event.error && AUTH_FAILED.has(event.error)) state.authFailed = true;
    opts.onEvent?.({ kind: "note", level: "warn", text: `[retry] ${event.error ?? "unknown"}` });
    return;
  }

  if (event.type === "assistant") {
    for (const next of describeContent(event.message?.content ?? [], opts.stage ?? "agent", opts.cwd)) opts.onEvent?.(next);
    return;
  }

  if (event.type === "result") {
    state.text = event.result ?? state.text;
    state.structured = event.structured_output;
    state.isError = event.is_error ?? false;
    state.costUsd = event.total_cost_usd ?? null;
    // Seen 2026-09-10: a stale keychain token produces no api_retry event,
    // only a result of "Failed to authenticate. API Error: 401 …".
    if (state.isError && /failed to authenticate|401/i.test(state.text)) state.authFailed = true;
  }
}

/**
 * Runs the prompt against each credential in turn, moving on when one reports
 * a usage limit or an auth failure. Resuming by session id keeps the
 * conversation intact across the swap. v1 ships with a one-element list; the
 * shape stays so that a second credential is a config change, never a rewrite.
 */
export const runClaudeWithFallback = (
  opts: Omit<ClaudeOptions, "credential"> & { readonly credentials: ReadonlyArray<Credential> },
): Effect.Effect<ClaudeResult, ClaudeError, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> => {
  const attempt = (index: number, resume: string | null): Effect.Effect<ClaudeResult, ClaudeError, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> => {
    const credential = opts.credentials[index];
    if (!credential) return Effect.die(new Error("No credentials configured"));
    const next = (error: AgentRateLimited | AgentUnauthorized) => {
      if (index + 1 >= opts.credentials.length) return Effect.fail(error);
      opts.onEvent?.({
        kind: "note",
        level: "warn",
        text: `[credential] ${credential.name} exhausted (${error._tag}), trying the next one`,
      });
      return attempt(index + 1, error.sessionId ?? resume);
    };
    opts.onEvent?.({ kind: "note", level: "detail", text: `[credential] ${credential.name}` });
    return runClaude({ ...opts, credential, resume }).pipe(
      Effect.catchTags({ AgentRateLimited: next, AgentUnauthorized: next }),
    );
  };
  // Suspended: `attempt` names the credential as it is called, and a caller
  // that brackets this in a wait builds the call before the wait opens. A
  // function returning an effect does not get to speak when it is called.
  return Effect.suspend(() => attempt(0, opts.resume ?? null));
};
