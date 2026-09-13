import { Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { remoteOf } from "../config.ts";
import { asFabrikaError, FabrikaError } from "../errors.ts";
import { exec, run } from "../infra/shell.ts";
import { Workspace, type MergeOutcome } from "../ports/workspace.ts";

/**
 * A git worktree under `~/.fabrika/worktrees/<repo>/<ticket>`, so nothing a
 * run does lands in the target repo's own tree.
 *
 * Stage artifacts (spec, plan, review notes, PR body) live in `WORK_DIR`
 * inside it, kept out of git through the repo's `.git/info/exclude` — shared
 * by every worktree — so they never reach a commit but survive for the human
 * who reads them next to the PR.
 */
export const WORK_DIR = ".fabrika/work";

/**
 * `git worktree list --porcelain` as branch-and-path pairs.
 *
 * Blank-line-separated blocks, one field per line; a detached worktree carries
 * `detached` where a branch would be and belongs to no branch. Exported
 * because this is the parse ADR-0004's hard reset is fenced by: a listing this
 * misreads is a sweep that resets a tree somebody is working in.
 */
export const checkedOut = (porcelain: string): ReadonlyArray<{ readonly branch: string; readonly path: string }> =>
  porcelain.split("\n\n").flatMap((block) => {
    const field = (name: string) =>
      block.split("\n").find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
    const where = field("worktree");
    const ref = field("branch");
    return where && ref ? [{ branch: ref.replace(/^refs\/heads\//, ""), path: where }] : [];
  });

/**
 * `owner/repo` for a repository, without building a `Workspace` first: a
 * sweep resolves it before it has a tree, and `Workspace.githubRepo` answers
 * through the same call, so the two cannot disagree.
 */
export const githubRepoAt = (repoRoot: string, base: string) => {
  const remote = remoteOf(base);
  return run(repoRoot, ["git", "remote", "get-url", remote]).pipe(
    Effect.mapError(asFabrikaError("git remote")),
    Effect.flatMap((url) => {
      const repo = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url)?.[1];
      return repo
        ? Effect.succeed(repo)
        : Effect.fail(new FabrikaError({ message: `remote ${remote} is not a GitHub URL: ${url}` }));
    }),
  );
};

export type WorkspaceOptions = {
  readonly repoRoot: string;
  readonly dir: string;
  /** The base as a remote ref, e.g. `origin/main`. */
  readonly base: string;
};

export const layer = (options: WorkspaceOptions) =>
  Layer.effect(Workspace)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repoRoot, dir, base } = options;
      const remote = remoteOf(base);
      // Captured once so the port stays free of platform requirements: a
      // caller of `Workspace` provides nothing, which is what lets a test
      // stand in for it with a plain object.
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawned = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
        Effect.provideService(effect, ChildProcessSpawner.ChildProcessSpawner, spawner);

      /** In the worktree, failing with the command that failed and its output. */
      const git = (argv: ReadonlyArray<string>, cwd = dir) =>
        spawned(run(cwd, ["git", ...argv])).pipe(Effect.mapError(asFabrikaError(`git ${argv[0]}`)));
      const lines = (out: string) => out.split("\n").filter(Boolean);

      const excludeWorkDir = Effect.gen(function* () {
        const common = yield* git(["rev-parse", "--git-common-dir"], repoRoot);
        const file = path.join(path.isAbsolute(common) ? common : path.join(repoRoot, common), "info", "exclude");
        const pattern = `${WORK_DIR}/`;
        const current = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
        if (current.split("\n").includes(pattern)) return;
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, current + (current && !current.endsWith("\n") ? "\n" : "") + pattern + "\n");
      }).pipe(Effect.mapError(asFabrikaError("excluding the artifacts directory")));

      const isDirty = git(["status", "--porcelain"]).pipe(Effect.map((out) => out.length > 0));
      const conflictedFiles = git(["diff", "--name-only", "--diff-filter=U"]).pipe(Effect.map(lines));

      return {
        dir,
        repoRoot,
        artifactsDir: path.join(dir, WORK_DIR),
        readArtifact: (name: string) =>
          Effect.gen(function* () {
            const file = path.join(dir, WORK_DIR, name);
            return (yield* fs.exists(file)) ? yield* fs.readFileString(file) : undefined;
          }).pipe(Effect.mapError(asFabrikaError(`reading ${WORK_DIR}/${name}`))),

        pinnedBranch: Effect.gen(function* () {
          const there = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
          return there ? yield* git(["branch", "--show-current"]) : undefined;
        }),
        githubRepo: spawned(githubRepoAt(repoRoot, base)),
        /**
         * Git rather than the filesystem: this catches a tree at *any* path —
         * a renamed pull request whose key no longer matches its directory
         * cannot slip past — and it catches the operator's own checkout.
         */
        checkedOutBranches: git(["worktree", "list", "--porcelain"], repoRoot).pipe(Effect.map(checkedOut)),

        /**
         * "Domen Perko" → `domen-perko`, for the `{user}` in the branch
         * pattern: the config is committed to the target repo, so the prefix
         * has to be whoever is running rather than a baked-in name.
         */
        user: git(["config", "user.name"], repoRoot).pipe(
          Effect.orElseSucceed(() => ""),
          Effect.flatMap((name) => {
            const user = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
            return user
              ? Effect.succeed(user)
              : Effect.fail(
                  new FabrikaError({
                    message: "branch pattern uses {user} but git user.name is unset — set it with `git config user.name`",
                  }),
                );
          }),
        ),

        create: (branch: string) =>
          Effect.gen(function* () {
            yield* excludeWorkDir;
            yield* git(["fetch", "--quiet", remote], repoRoot);
            if (yield* fs.exists(dir)) {
              const current = yield* git(["branch", "--show-current"]);
              if (current !== branch) {
                return yield* new FabrikaError({ message: `${dir} exists on branch ${current}, expected ${branch}` });
              }
              return;
            }
            yield* fs.makeDirectory(path.dirname(dir), { recursive: true });
            const existing = yield* git(["branch", "--list", branch], repoRoot);
            yield* existing
              ? git(["worktree", "add", dir, branch], repoRoot)
              : git(["worktree", "add", "-b", branch, dir, base], repoRoot);
          }).pipe(Effect.mapError((e) => (e instanceof FabrikaError ? e : asFabrikaError("creating the worktree")(e)))),

        /**
         * A sweep's entry into a tree. It hard-resets to `<remote>/<branch>`:
         * the local branch that survived `worktree remove` can hold an
         * escalated run's tip or a history someone rewrote, and a merge
         * computed against that resolves conflicts nobody has (ADR-0004).
         *
         * It resets only a tree it just created. The selection rule that
         * fences the reset — skip a branch checked out anywhere on this
         * machine — reads `git worktree list` once, before the fan-out, so a
         * tree that is already here is one that appeared since: a second
         * `fabrika sync`, whose agent is mid-merge in it. Refusing costs one
         * pull request this sweep; resetting costs the other sweep's work.
         */
        checkout: (branch: string) =>
          Effect.gen(function* () {
            yield* excludeWorkDir;
            yield* git(["fetch", "--quiet", remote], repoRoot);
            const tip = `${remote}/${branch}`;
            const known = yield* git(["rev-parse", "--verify", "--quiet", tip], repoRoot).pipe(
              Effect.orElseSucceed(() => ""),
            );
            if (!known) {
              return yield* new FabrikaError({ message: `${tip} does not exist — nothing to check out` });
            }
            if (yield* fs.exists(dir)) {
              // Not "remove it and retry": the tree this refuses to touch is
              // most likely another sync's, mid-merge, and an operator who
              // reads a suggestion in a log acts on it.
              return yield* new FabrikaError({
                message: `${dir} already exists — another sync may still be working in it; leave it until that one is done`,
              });
            }
            yield* fs.makeDirectory(path.dirname(dir), { recursive: true });
            const existing = yield* git(["branch", "--list", branch], repoRoot);
            yield* existing
              ? git(["worktree", "add", dir, branch], repoRoot)
              : git(["worktree", "add", "-b", branch, dir, tip], repoRoot);
            yield* git(["reset", "--hard", tip]);
          }).pipe(Effect.mapError((e) => (e instanceof FabrikaError ? e : asFabrikaError("checking out the branch")(e)))),

        install: (command: string) =>
          Effect.gen(function* () {
            if (yield* fs.exists(path.join(dir, "node_modules"))) return false;
            yield* spawned(run(dir, ["sh", "-c", command])).pipe(Effect.mapError(asFabrikaError(`install (${command})`)));
            return true;
          }).pipe(Effect.mapError((e) => (e instanceof FabrikaError ? e : asFabrikaError("installing dependencies")(e)))),

        remove: git(["worktree", "remove", "--force", dir], repoRoot).pipe(Effect.asVoid),

        commitAll: (message: string) =>
          Effect.gen(function* () {
            if (!(yield* isDirty)) return false;
            yield* git(["add", "-A"]);
            yield* git(["commit", "--quiet", "-m", message]);
            return true;
          }),
        emptyCommit: (message: string) => git(["commit", "--quiet", "--allow-empty", "-m", message]).pipe(Effect.asVoid),
        head: git(["rev-parse", "HEAD"]),
        baseSha: git(["rev-parse", base]),
        commitCount: git(["rev-list", "--count", `${base}..HEAD`]).pipe(Effect.map(Number)),
        changedFiles: git(["diff", "--name-only", `${base}...HEAD`]).pipe(Effect.map(lines)),
        filesSince: (sha: string) => git(["diff", "--name-only", `${sha}..HEAD`]).pipe(Effect.map(lines)),

        /**
         * Merge, never rebase: pushed commits stay put, so a reviewer's
         * per-commit findings stay valid across a base that keeps moving.
         */
        mergeBase: Effect.gen(function* () {
          yield* git(["fetch", "--quiet", remote]);
          const behind = Number(yield* git(["rev-list", "--count", `HEAD..${base}`]));
          if (behind === 0) return { _tag: "UpToDate" } satisfies MergeOutcome;
          const merged = yield* spawned(exec(dir, ["git", "merge", "--no-edit", base])).pipe(
            Effect.mapError(asFabrikaError(`git merge ${base}`)),
          );
          if (merged.code === 0) return { _tag: "Merged", behind } satisfies MergeOutcome;
          const files = yield* conflictedFiles;
          return (
            files.length > 0
              ? { _tag: "Conflicted", behind, files }
              : { _tag: "Failed", output: merged.out.trim().slice(-300) }
          ) satisfies MergeOutcome;
        }),
        conflictedFiles,
        finishMerge: Effect.gen(function* () {
          const inProgress = yield* spawned(exec(dir, ["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"])).pipe(
            Effect.map((r) => r.code === 0),
            Effect.mapError(asFabrikaError("checking for a merge in progress")),
          );
          if (!inProgress) return false;
          yield* git(["add", "-A"]);
          yield* git(["commit", "--quiet", "--no-edit"]);
          return true;
        }),

        // The sha is read after the push rather than before it, so what is
        // recorded as pushed is what the remote was given.
        push: (branch: string) =>
          git(["push", "--quiet", "-u", remote, branch]).pipe(Effect.andThen(git(["rev-parse", "HEAD"]))),
      } satisfies Workspace;
    }),
  );
