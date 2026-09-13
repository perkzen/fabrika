import { Context, Data, type Effect } from "effect";

/**
 * The coding agent a stage talks to.
 *
 * One call. Everything a caller would otherwise have to get right — which
 * credential, which session to resume, which MCP servers this stage may see,
 * the deny list, where the raw transcript is written, what a cost line looks
 * like — sits behind it. A step names the unit of work and the prompt; the
 * adapter decides the rest.
 *
 * `session` is the key of the conversation this call belongs to, defaulting
 * to the stage name. Two calls with the same key continue one conversation,
 * which is what makes a gate retry work: the agent told "compile failed, fix
 * it" is the one that wrote the code. Different keys never see each other.
 */
export type AgentRequest = {
  readonly stage: string;
  /** Conversation key; defaults to `stage`. */
  readonly session?: string;
  readonly prompt: string;
  /** Persistent role identity for this stage, as an absolute path. */
  readonly systemPromptFile?: string;
  /** Names of MCP servers this call may use; resolved by the adapter. */
  readonly mcp?: ReadonlyArray<string>;
  /** JSON Schema string; the answer arrives in `structured`. */
  readonly jsonSchema?: string;
  /** Defaults to the workspace; the naming call runs before one exists. */
  readonly cwd?: string;
  /** Overrides the model every call otherwise takes; a configured stage names its own. */
  readonly model?: string;
};

export type AgentReply = {
  readonly text: string;
  /** Parsed structured output when the request carried a `jsonSchema`. */
  readonly structured: unknown;
};

/** The agent cannot authenticate at all — a human has to log in. */
export class AgentUnauthorized extends Data.TaggedError("AgentUnauthorized")<{
  readonly credential: string;
  readonly sessionId: string | null;
  readonly message: string;
}> {}

/** The credential is out of budget for now; the run is resumable once it resets. */
export class AgentRateLimited extends Data.TaggedError("AgentRateLimited")<{
  readonly credential: string;
  readonly sessionId: string | null;
}> {}

/** The call ran and came back wrong: a non-zero exit, or an error result. */
export class AgentFailed extends Data.TaggedError("AgentFailed")<{
  /** The subprocess exit code, or `null` when it never got that far. */
  readonly exitCode: number | null;
  readonly sessionId: string | null;
  readonly message: string;
}> {}

export type AgentError = AgentUnauthorized | AgentRateLimited | AgentFailed;

export interface Agent {
  readonly ask: (request: AgentRequest) => Effect.Effect<AgentReply, AgentError>;
  /**
   * Fails if these MCP servers cannot be handed to a call. A run asks once up
   * front for every stage, because the alternative is discovering it after a
   * long install, three stages in.
   */
  readonly ensureTools: (mcp: ReadonlyArray<string>) => Effect.Effect<void, AgentError>;
}

export const Agent = Context.Service<Agent>("Agent");
