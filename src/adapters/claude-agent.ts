import { Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { runClaudeWithFallback, type Credential } from "../infra/claude.ts";
import { mcpConfigFile, resolveServers } from "../infra/mcp.ts";
import { Agent, AgentFailed, type AgentError, type AgentReply, type AgentRequest } from "../ports/agent.ts";
import { Journal } from "../ports/journal.ts";
import { RunStore } from "../ports/run-store.ts";

export type AgentOptions = {
  readonly repoRoot: string;
  /** Where a call runs unless it says otherwise — the run's worktree. */
  readonly defaultCwd: string;
  readonly credentials: ReadonlyArray<Credential>;
  /** Permission rules every call is denied; the host does its own pushing and merging. */
  readonly deny: ReadonlyArray<string>;
};

const AGENT_TAGS = new Set(["AgentUnauthorized", "AgentRateLimited", "AgentFailed"]);

/** Anything that is not already one of the agent's own failures is one, with the cause as its message. */
const asAgentError = (cause: unknown): AgentError =>
  typeof cause === "object" && cause !== null && "_tag" in cause && AGENT_TAGS.has(String((cause as { _tag: unknown })._tag))
    ? (cause as AgentError)
    : new AgentFailed({
        exitCode: null,
        sessionId: null,
        message: cause instanceof Error ? cause.message : String(cause),
      });

/**
 * Claude Code, one subprocess per call.
 *
 * Sessions are the part worth reading. Each unit of work has a key —
 * the stage name by default — and the session id behind it is recorded in the
 * run's state as soon as the call returns, so a resumed run continues the same
 * conversation rather than starting a cold one. Stages get a key each, which
 * is what keeps `implement` from inheriting the spec conversation: what
 * travels between stages is the artifacts and the commits, written down
 * rather than remembered.
 *
 * A stage's MCP servers are resolved and written to a scoped 0600 file for
 * that one call, so a stage sees exactly the servers it named and the file is
 * gone whichever way the call ends.
 */
export const layer = (options: AgentOptions) =>
  Layer.effect(Agent)(
    Effect.gen(function* () {
      const store = yield* RunStore;
      const journal = yield* Journal;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      /** Distinguishes the raw transcripts of repeated calls in one stage. */
      let call = 0;

      const ask = (request: AgentRequest): Effect.Effect<AgentReply, AgentError> =>
        Effect.scoped(
          Effect.gen(function* () {
            const servers = request.mcp?.length ? yield* resolveServers(options.repoRoot, request.mcp) : undefined;
            const mcp = servers ? yield* mcpConfigFile(servers) : undefined;
            const key = request.session ?? request.stage;
            const result = yield* runClaudeWithFallback({
              cwd: request.cwd ?? options.defaultCwd,
              prompt: request.prompt,
              credentials: options.credentials,
              resume: store.get().sessions[key] ?? null,
              systemPromptFile: request.systemPromptFile,
              mcpConfigFile: mcp,
              disallowedTools: options.deny,
              jsonSchema: request.jsonSchema,
              rawLog: path.join(store.directory, `${request.stage}-${++call}.jsonl`),
              onLine: (line) => journal.write(`  ${line.slice(0, 400).replace(/\n/g, " ")}`),
            });
            // Recorded before anything is done with the answer: a run that
            // dies here has to resume into this conversation, not a new one.
            yield* store.update((state) => {
              if (result.sessionId) state.sessions[key] = result.sessionId;
            });
            if (result.costUsd !== null) yield* journal.log(`  (${request.stage}: $${result.costUsd.toFixed(2)})`);
            return { text: result.text, structured: result.structured } satisfies AgentReply;
          }),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(asAgentError),
        );

      const ensureTools = (mcp: ReadonlyArray<string>) =>
        resolveServers(options.repoRoot, mcp).pipe(
          Effect.asVoid,
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(asAgentError),
        );

      return { ask, ensureTools } satisfies Agent;
    }),
  );
