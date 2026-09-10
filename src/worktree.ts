import { Effect, FileSystem, Path } from "effect";
import { FabrikaError } from "./errors.ts";
import { homedir } from "node:os";
import { exec, run } from "./shell.ts";

/**
 * Worktrees live outside the target repo so nothing lands in its tree. Not
 * `acquireRelease` on purpose: when a run escalates, the human needs the
 * worktree to look at. It is removed only on the success path.
 */
export const worktreePath = (repoRoot: string, identifier: string) =>
  Effect.map(Path.Path, (path) =>
    path.join(homedir(), ".fabrika", "worktrees", path.basename(repoRoot), identifier),
  );

/**
 * Stage artifacts (spec, plan, review notes, PR body) live here in the
 * worktree. Excluded through the repo's own `.git/info/exclude` — which every
 * worktree shares — so they stay out of the PR without touching the target
 * repo's `.gitignore`.
 */
export const WORK_DIR = ".fabrika/work";

const excludeWorkDir = (repoRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const common = yield* run(repoRoot, ["git", "rev-parse", "--git-common-dir"]);
    const file = path.join(path.isAbsolute(common) ? common : path.join(repoRoot, common), "info", "exclude");
    const pattern = `${WORK_DIR}/`;
    const current = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
    if (current.split("\n").includes(pattern)) return;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, current + (current && !current.endsWith("\n") ? "\n" : "") + pattern + "\n");
  });

export const remoteOf = (base: string) => (base.includes("/") ? base.split("/")[0]! : "origin");
export const baseBranch = (base: string) => (base.includes("/") ? base.slice(base.indexOf("/") + 1) : base);

/** Creates `branch` off a freshly fetched `base`; reuses the worktree if it already exists on that branch. */
export const create = (repoRoot: string, dir: string, branch: string, base: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* excludeWorkDir(repoRoot);
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

/** Commits on `base` that HEAD does not have yet. */
export const behind = (dir: string, base: string) =>
  run(dir, ["git", "rev-list", "--count", `HEAD..${base}`]).pipe(Effect.map(Number));

/** Merges `base` into HEAD. A non-zero code with conflicted files means the merge is waiting for a resolution. */
export const merge = (dir: string, base: string) => exec(dir, ["git", "merge", "--no-edit", base]);

export const conflictedFiles = (dir: string) =>
  run(dir, ["git", "diff", "--name-only", "--diff-filter=U"]).pipe(
    Effect.map((out) => out.split("\n").filter(Boolean)),
  );

export const mergeInProgress = (dir: string) =>
  exec(dir, ["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"]).pipe(Effect.map((r) => r.code === 0));

export const push = (dir: string, remote: string, branch: string) =>
  run(dir, ["git", "push", "--quiet", "-u", remote, branch]).pipe(Effect.asVoid);

export const emptyCommit = (dir: string, message: string) =>
  run(dir, ["git", "commit", "--quiet", "--allow-empty", "-m", message]).pipe(Effect.asVoid);
