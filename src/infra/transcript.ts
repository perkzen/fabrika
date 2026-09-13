import { isAbsolute, relative } from "node:path";
import type { RunEvent } from "../domain/run-event.ts";

/** Long enough to name a file or a command, short enough that a tool call is one line. */
const SUBJECT = 120;

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/**
 * What one tool call is about, in a few words — a path, a command, a pattern.
 *
 * A table with a default that gives up rather than guesses: an unknown tool
 * is described by its name alone, because a wrong subject is worse than
 * none. `cwd` is the worktree, so a file path reads as the operator knows it.
 */
export const describeToolUse = (tool: string, input: Record<string, unknown>, cwd: string): string => {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
  // An MCP tool's input is the server's business, not the operator's; the
  // server and the tool are the whole subject.
  if (mcp) return `${mcp[1]}/${mcp[2]}`;

  switch (tool) {
    case "Bash":
      return oneLine(text(input.description) ?? text(input.command)?.split("\n")[0]);
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return oneLine(path(input.file_path, cwd));
    case "Glob":
    case "Grep": {
      const pattern = text(input.pattern);
      const where = text(input.path);
      return oneLine(pattern && where ? `${pattern} in ${where}` : pattern);
    }
    case "Task":
    case "Agent":
      return oneLine(text(input.description));
    case "WebFetch":
      return oneLine(text(input.url));
    case "WebSearch":
      return oneLine(text(input.query));
    case "Skill":
      return oneLine(text(input.skill));
    case "TodoWrite":
      return Array.isArray(input.todos) ? `${input.todos.length} todos` : "";
    default:
      return "";
  }
};

const path = (value: unknown, cwd: string): string | undefined => {
  const file = text(value);
  return file && isAbsolute(file) ? relative(cwd, file) : file;
};

const oneLine = (subject: string | undefined) => (subject ?? "").replace(/\s+/g, " ").trim().slice(0, SUBJECT);

/** One assistant message's content blocks, as the wire delivers them. */
export type ContentBlock = {
  readonly type?: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
};

/**
 * What one assistant message is worth telling the operator: what it said, if
 * anything, and then each tool it reached for, in the order it reached.
 *
 * The ordering lives here rather than in the stream reader so it is covered
 * by the same seam as the subject table — the only seam above it spawns the
 * real `claude` binary.
 */
export const describeContent = (
  blocks: ReadonlyArray<ContentBlock>,
  stage: string,
  cwd: string,
): ReadonlyArray<RunEvent> => {
  const events: Array<RunEvent> = [];
  const said = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  if (said.trim()) events.push({ kind: "agent", stage, markdown: said.trim() });
  for (const block of blocks) {
    // StructuredOutput is how `--json-schema` delivers its answer, not work
    // the operator cares about.
    if (block.type !== "tool_use" || !block.name || block.name === "StructuredOutput") continue;
    events.push({ kind: "tool", stage, tool: block.name, subject: describeToolUse(block.name, block.input ?? {}, cwd) });
  }
  return events;
};
