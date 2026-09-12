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
