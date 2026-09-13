import { Duration, Effect, FileSystem, Layer, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { cacheKey, kindOf, linkTarget, textContent, type CaptureFile, type Shot } from "../domain/captures.ts";
import type { CaptureStep } from "../config.ts";
import { run, sh, withoutSecrets } from "../infra/shell.ts";
import { Captures } from "../ports/captures.ts";
import { Journal, waitFor } from "../ports/journal.ts";
import { RunStore } from "../ports/run-store.ts";
import { Workspace } from "../ports/workspace.ts";

/** A terminal frame takes seconds; a simulator build takes minutes, and says so in its own `timeoutMinutes`. */
const DEFAULT_CAPTURE_MINUTES = 2;
/** About five screenshots per capture per revision — more than a reviewer will look at. */
const CAPTURE_BYTES = 5 * 1024 * 1024;
/** GitHub's own per-attachment limit: a larger file would fail the upload rather than be dropped quietly. */
const ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type CapturesOptions = {
  /** `~/.fabrika/captures/<repo>` — where a base half is kept, keyed by sha and capture name. */
  readonly cacheRoot: string;
  /** The dependency install a fresh base checkout needs before a capture can run. */
  readonly install: string | undefined;
};

const seconds = (from: number) => Number(((Date.now() - from) / 1000).toFixed(0));

/**
 * The host running each capture twice: once in a detached checkout of the
 * base, once in the run's own tree.
 *
 * Nothing here fails. Every way a capture can go wrong — a non-zero exit, a
 * timeout, an overrun cap, an empty directory, a base that will not check out
 * or install — ends as a missing half, because the pull request is the point
 * and the captures are evidence attached to it.
 *
 * Everything that can be decided from the data is in `src/domain/captures.ts` and
 * tested there; what is left here is process spawning, `git worktree` and
 * directory reads, which this repo has no seam for.
 */
export const layer = (options: CapturesOptions) =>
  Layer.effect(Captures)(
    Effect.gen(function* () {
      const workspace = yield* Workspace;
      const store = yield* RunStore;
      const journal = yield* Journal;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const spawned = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
        Effect.provideService(effect, ChildProcessSpawner.ChildProcessSpawner, spawner);
      const git = (argv: ReadonlyArray<string>) => spawned(run(workspace.repoRoot, ["git", ...argv]));

      const emptied = (dir: string) =>
        fs.remove(dir, { recursive: true, force: true }).pipe(
          Effect.ignore,
          Effect.andThen(fs.makeDirectory(dir, { recursive: true })),
          Effect.as(dir),
        );

      /**
       * Runs one capture in one tree, into an empty directory of its own.
       * `false` when the command failed, never started, or ran out of time; the
       * spawner kills the child it acquired when the timeout interrupts the scope.
       */
      const command = (capture: CaptureStep, cwd: string, into: string) =>
        Effect.gen(function* () {
          const result = yield* spawned(
            // `false`: a capture's output is published on a pull request, so
            // it is the one child that must not be holding a key when it
            // prints — and an inherited environment cannot be merged down to
            // less than itself.
            sh(cwd, capture.run, { ...withoutSecrets(process.env), FABRIKA_CAPTURE_DIR: into }, false),
          ).pipe(
            Effect.timeoutOption(Duration.minutes(capture.timeoutMinutes ?? DEFAULT_CAPTURE_MINUTES)),
            Effect.map((done) => (Option.isSome(done) ? done.value : ("timed out" as const))),
            // A child that never started is a different thing to tell the
            // operator than one that outstayed a deadline.
            Effect.orElseSucceed(() => "could not be started" as const),
          );
          if (typeof result === "string") {
            yield* journal.log(`capture ${capture.name}: ${result}; no half`);
            return false;
          }
          if (result.code !== 0) {
            yield* journal.log(`capture ${capture.name}: command failed (exit ${result.code}); no half`);
            return false;
          }
          return true;
        });

      /**
       * What a capture wrote, in sorted name order so the two halves pair
       * deterministically, bounded by the byte caps. A file whose kind the
       * body cannot carry is not a file.
       */
      const filesIn = (capture: string, dir: string) =>
        Effect.gen(function* () {
          const names = [...(yield* fs.readDirectory(dir))].sort();
          const files: Array<CaptureFile> = [];
          let budget = CAPTURE_BYTES;
          for (const name of names) {
            const kind = kindOf(name);
            if (!kind) continue;
            const full = path.join(dir, name);
            const size = Number((yield* fs.stat(full)).size);
            if (size > budget || (kind === "image" && size > ATTACHMENT_BYTES)) {
              // Said out loud: an image that is simply never there reads as a
              // capture that failed, and the operator would go looking.
              yield* journal.log(`capture ${capture}: ${name} (${(size / 1024 / 1024).toFixed(1)} MB) left out — over the cap`);
              continue;
            }
            budget -= size;
            if (kind === "image") {
              files.push({ name, kind, content: full });
              continue;
            }
            const raw = yield* fs.readFileString(full);
            const content = kind === "text" ? textContent(raw) : linkTarget(raw);
            if (content) files.push({ name, kind, content });
          }
          return files;
        }).pipe(Effect.orElseSucceed(() => [] as Array<CaptureFile>));

      /**
        * Keyed by the command as well as the name: a run that decides its own
        * capture can bring a different command under the same obvious name,
        * and pairing this branch's after against that one's before is a
        * comparison of two commands rather than of two revisions.
        */
      const cacheDir = (baseSha: string, capture: CaptureStep) =>
        path.join(options.cacheRoot, baseSha, cacheKey(capture.name, capture.run));

      /** Non-empty means the command already ran at this sha; a half-written directory never becomes one. */
      const cached = (baseSha: string, capture: CaptureStep) =>
        fs.readDirectory(cacheDir(baseSha, capture)).pipe(
          Effect.map((names) => names.length > 0),
          Effect.orElseSucceed(() => false),
        );

      /**
       * A detached checkout of the base, shared by every capture at that sha
       * so the checkout and the install are paid once. A crashed run leaves
       * the path registered and `git worktree add` would refuse it forever,
       * so it is removed and pruned before it is added.
       */
      const inBaseTree = (baseSha: string, budgetMinutes: number, use: (dir: string) => Effect.Effect<void>) =>
        Effect.gen(function* () {
          const dir = path.join(store.directory, "base", baseSha);
          const ready = yield* Effect.gen(function* () {
            yield* git(["worktree", "remove", "--force", dir]).pipe(Effect.ignore);
            yield* git(["worktree", "prune"]).pipe(Effect.ignore);
            yield* fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore);
            yield* git(["worktree", "add", "--detach", dir, baseSha]);
            // Registered in the outer scope, so the tree is removed after the
            // captures have had it rather than when this budget closes.
            yield* Effect.addFinalizer(() =>
              git(["worktree", "remove", "--force", dir]).pipe(Effect.ignore, Effect.andThen(git(["worktree", "prune"]).pipe(Effect.ignore))),
            );
            if (options.install) {
              // `sh` answers a result rather than failing, so a non-zero
              // install reads as a tree that is ready when it is half-built.
              const install = yield* spawned(sh(dir, options.install));
              if (install.code !== 0) {
                yield* journal.log(`captures: base ${baseSha.slice(0, 7)} install failed (exit ${install.code}); no base half`);
                return false;
              }
            }
            return true;
          }).pipe(
            // The checkout and the install sit outside any one capture's
            // command, and an install that hangs stalls the run as surely as a
            // capture that does; they share one budget. The commands they make
            // possible are bounded one by one, by their own `timeoutMinutes`.
            Effect.timeoutOption(Duration.minutes(budgetMinutes)),
            Effect.map((done) => Option.isSome(done) && done.value),
            Effect.catchCause(() => Effect.succeed(false)),
            waitFor(journal, `base ${baseSha.slice(0, 7)} for the captures`, budgetMinutes),
          );
          if (ready) yield* use(dir);
        }).pipe(Effect.scoped, Effect.catchCause(() => Effect.void), Effect.asVoid);

      const take = (captures: ReadonlyArray<CaptureStep>, baseSha: string) =>
        Effect.gen(function* () {
          const staging = path.join(store.directory, "captures");
          const misses: Array<CaptureStep> = [];
          for (const capture of captures) {
            if (yield* cached(baseSha, capture)) {
              yield* journal.log(`capture ${capture.name}: base ${baseSha.slice(0, 7)} (from cache)`);
            } else {
              misses.push(capture);
            }
          }

          if (misses.length > 0) {
            const budget = Math.max(...misses.map((capture) => capture.timeoutMinutes ?? DEFAULT_CAPTURE_MINUTES));
            yield* inBaseTree(baseSha, budget, (dir) =>
              Effect.gen(function* () {
                for (const capture of misses) {
                  const started = Date.now();
                  // Staged first and copied into the cache only once the
                  // command succeeded: what a failing command wrote must never
                  // read as a hit to the next ticket cut from this base.
                  const into = yield* emptied(path.join(staging, capture.name, "base"));
                  if (!(yield* command(capture, dir, into))) continue;
                  const files = yield* filesIn(capture.name, into);
                  if (files.length === 0) {
                    yield* journal.log(`capture ${capture.name}: base wrote nothing`);
                    continue;
                  }
                  const cache = yield* emptied(cacheDir(baseSha, capture));
                  for (const file of files) yield* fs.copyFile(path.join(into, file.name), path.join(cache, file.name));
                  yield* journal.log(`capture ${capture.name}: base ${baseSha.slice(0, 7)} captured in ${seconds(started)}s`);
                }
              }).pipe(Effect.orElseSucceed(() => undefined), Effect.asVoid),
            );
          }

          const shots: Array<Shot> = [];
          for (const capture of captures) {
            const hit = yield* cached(baseSha, capture);
            const before = hit ? yield* filesIn(capture.name, cacheDir(baseSha, capture)) : undefined;
            const into = yield* emptied(path.join(staging, capture.name, "head"));
            // The branch half is never cached: it is cheap next to the base
            // and it has to follow the commits.
            const after = (yield* command(capture, workspace.dir, into)) ? yield* filesIn(capture.name, into) : undefined;
            if (!after || after.length === 0) yield* journal.log(`capture ${capture.name}: no output; no section`);
            shots.push({ capture: capture.name, before, after });
          }
          return shots as ReadonlyArray<Shot>;
        }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<Shot>));

      return { take } satisfies Captures;
    }),
  );
