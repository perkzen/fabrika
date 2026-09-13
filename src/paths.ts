import type { Path } from "effect";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * The package root, resolved from this file's own URL. Every path fabrika
 * ships — the prompts, the skills plugin — hangs off it.
 *
 * This module deliberately sits at the top of `src/`: `tsconfig.build.json`
 * emits `src/**` to `dist/**` with the structure intact, so `..` from here is
 * the package root whether the code runs from a checkout or from `dist/`.
 * Resolving the same URL from a file one directory deeper would silently
 * land inside `src/`, which is why nothing else does this lookup.
 */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Stage prompts, with a trailing separator so `new URL` joins cleanly. */
export const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

/** `--plugin-dir` for every `claude -p` call: the manifest in `.claude-plugin/` exposes `skills/`. */
export const PLUGIN_DIR = PACKAGE_ROOT;

/**
 * Where fabrika keeps what a run must not lose: state, logs and raw
 * transcripts outside the target repo, the worktree outside it as well. Both
 * are keyed by repository and key — a ticket identifier for a run, a pull
 * request's key for a sweep's worker — so two of either never share a
 * directory.
 *
 * A plain join over a `Path` the caller already holds, so a sweep can resolve
 * a path inside a callback that must have no requirements of its own. It lives
 * here rather than in either composition root: the run's root and the sweep's
 * are siblings, and the second importing the first would say one is built on
 * the other.
 */
export const home = (path: Path.Path, kind: "runs" | "worktrees", repoRoot: string, key: string) =>
  path.join(homedir(), ".fabrika", kind, path.basename(repoRoot), key);
