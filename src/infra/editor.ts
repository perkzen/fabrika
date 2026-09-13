import { detached, withoutSecrets } from "./shell.ts";

/**
 * What `o` does, already bound to the worktree — or nothing, when this machine
 * has no answer for what opens a directory. The one value decides both whether
 * the key does anything and whether the keys row names it, so the two cannot
 * disagree.
 *
 * The environment and the platform are arguments rather than globals read
 * here, and so is the spawn, so a test asserts the argv an editor would have
 * been launched with without launching one. `FABRIKA_EDITOR` is split on runs
 * of whitespace and the worktree appended as one more entry, never handed to a
 * shell: an editor whose name has a space in it is named by a bundle id or a
 * wrapper script.
 *
 * The editor gets this environment minus its credentials. An editor is a
 * process the operator then works inside — its terminal, its tasks, its
 * extensions all inherit what it was started with — and none of that is work
 * fabrika's Linear or Claude keys belong to. The ssh agent is the exception:
 * its socket is named like a credential and is not one, and a terminal in
 * there still has to push.
 */
export const editorOpener = (
  dir: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  spawn: (bin: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => void = detached,
): (() => void) | undefined => {
  const named = env.FABRIKA_EDITOR?.trim();
  // macOS already knows what opens a directory; elsewhere there is nothing
  // worth guessing, and a key that cannot do anything is worse than no key.
  const [bin, ...args] = named ? named.split(/\s+/) : platform === "darwin" ? ["open"] : [];
  if (bin === undefined) return undefined;
  return () => spawn(bin, [...args, dir], withoutSecrets(env, ["SSH_AUTH_SOCK"]));
};
