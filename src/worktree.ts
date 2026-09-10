import { Effect, FileSystem, Path } from "effect";
import { FabrikaError } from "./errors.ts";
import { homedir } from "node:os";
import { run } from "./shell.ts";

/**
 * Worktrees live outside the target repo so nothing lands in its tree. Not
 * `acquireRelease` on purpose: when a run escalates, the human needs the
 * worktree to look at. It is removed only on the success path.
 */
export const worktreePath = (repoRoot: string, identifier: string) =>
  Effect.map(Path.Path, (path) =>
    path.join(homedir(), ".fabrika", "worktrees", path.basename(repoRoot), identifier),
  );

export const remoteOf = (base: string) => (base.includes("/") ? base.split("/")[0]! : "origin");
export const baseBranch = (base: string) => (base.includes("/") ? base.slice(base.indexOf("/") + 1) : base);

/** Creates `branch` off a freshly fetched `base`; reuses the worktree if it already exists on that branch. */
export const create = (repoRoot: string, dir: string, branch: string, base: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* run(repoRoot, ["git", "fetch", "--quiet", remoteOf(base)]);
    if (yield* fs.exists(dir)) {
      const current = yield* run(dir, ["git", "branch", "--show-current"]);
      if (current !== branch) {
        return yield* new FabrikaError({ message: `${dir} exists on branch ${current}, expected ${branch}` });
      }
      return dir;
    }
    yield* fs.makeDirectory(dir.slice(0, dir.lastIndexOf("/")), { recursive: true });
    const existing = yield* run(repoRoot, ["git", "branch", "--list", branch]);
    yield* existing
      ? run(repoRoot, ["git", "worktree", "add", dir, branch])
      : run(repoRoot, ["git", "worktree", "add", "-b", branch, dir, base]);
    return dir;
  });

export const remove = (repoRoot: string, dir: string) =>
  run(repoRoot, ["git", "worktree", "remove", "--force", dir]).pipe(Effect.asVoid);

export const changedFiles = (dir: string, base: string) =>
  run(dir, ["git", "diff", "--name-only", `${base}...HEAD`]).pipe(
    Effect.map((out) => out.split("\n").filter(Boolean)),
  );

export const commitCount = (dir: string, base: string) =>
  run(dir, ["git", "rev-list", "--count", `${base}..HEAD`]).pipe(Effect.map(Number));

export const isDirty = (dir: string) =>
  run(dir, ["git", "status", "--porcelain"]).pipe(Effect.map((out) => out.length > 0));

export const head = (dir: string) => run(dir, ["git", "rev-parse", "HEAD"]);

/** Files touched by commits since `sha` (exclusive). */
export const filesSince = (dir: string, sha: string) =>
  run(dir, ["git", "diff", "--name-only", `${sha}..HEAD`]).pipe(
    Effect.map((out) => out.split("\n").filter(Boolean)),
  );

export const push = (dir: string, remote: string, branch: string) =>
  run(dir, ["git", "push", "--quiet", "-u", remote, branch]).pipe(Effect.asVoid);

export const emptyCommit = (dir: string, message: string) =>
  run(dir, ["git", "commit", "--quiet", "--allow-empty", "-m", message]).pipe(Effect.asVoid);
