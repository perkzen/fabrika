import { detached } from "./shell.ts";

/**
 * The operator's editor as argv, or nothing when this machine has no answer.
 *
 * The environment and the platform are arguments rather than globals read
 * here, so the decision is a function a test calls and the same test passes on
 * any machine. `FABRIKA_EDITOR` is split on runs of whitespace and never
 * handed to a shell: an editor whose name has a space in it is named by a
 * bundle id or a wrapper script.
 */
export const editorCommand = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ReadonlyArray<string> | undefined => {
  const named = env.FABRIKA_EDITOR?.trim();
  if (named) return named.split(/\s+/);
  // macOS already knows what opens a directory; elsewhere there is nothing
  // worth guessing, and a key that cannot do anything is worse than no key.
  return platform === "darwin" ? ["open"] : undefined;
};

/** The worktree in that editor. The path is one argv entry, so nothing in it can be read as a command. */
export const openEditor = (argv: ReadonlyArray<string>, dir: string): void => {
  const [bin, ...args] = argv;
  if (bin === undefined) return;
  detached(bin, [...args, dir]);
};
