import { isAbsolute, relative } from "node:path";

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
