import { Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as claudeAgent from "./adapters/claude-agent.ts";
import * as fileJournal from "./adapters/file-journal.ts";
import * as fileRunStore from "./adapters/file-run-store.ts";
import * as fsPrompts from "./adapters/fs-prompts.ts";
import * as ghForge from "./adapters/gh-forge.ts";
import * as gitWorkspace from "./adapters/git-workspace.ts";
import * as noReviewer from "./adapters/no-reviewer.ts";
import * as shellGate from "./adapters/shell-gate.ts";
import { baseBranch, type Config } from "./config.ts";
import type { Credential } from "./infra/claude.ts";
import { editorLauncher } from "./infra/editor.ts";
import { sweep, type Placement } from "./pipeline/sweep.ts";
import { type SyncTarget } from "./pipeline/sweep-selection.ts";
import { syncPullRequest } from "./pipeline/sync-worker.ts";
import { home } from "./paths.ts";

export type SweepOptions = {
  readonly dryRun: boolean;
  readonly concurrency: number;
};

/**
 * Assembles one sweep and executes it.
 *
 * Two layer graphs, not one. The discovery side is the repository itself — a
 * forge that needs no worktree and a `Workspace` over the checkout, of which
 * only `checkedOutBranches` is ever called. Each worker then gets its own
 * graph over its own tree, run directory and agent session, and shares nothing
 * with its siblings but the surface.
 *
 * The surface is the sweep's alone, and a worker reaches it only through the
 * row it was handed: six of them cannot fight over the terminal, the address
 * travels with the layer graph rather than through a global, and every event
 * still lands in that worker's own `log.txt` unchanged.
 */
export const runSweep = (config: Config, credentials: ReadonlyArray<Credential>, options: SweepOptions) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const repoRoot = process.cwd();
    const repo = yield* gitWorkspace.githubRepoAt(repoRoot, config.base);

    // Captured as values and handed back as a layer: `place` and `worker` are
    // closures the sweep calls with no context of its own, so everything they
    // reach for has to be resolved here.
    const platform = Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem)(fs),
      Layer.succeed(Path.Path)(path),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner),
    );

    // One surface for the whole sweep, ended by its own finaliser. A worker's
    // journal is its `log.txt` plus the row this hands out, so six of them
    // cannot fight over the terminal and each still has somewhere to be read.
    // `o` is given the launcher rather than an opener: the tree it opens is
    // the selected row's, and a sweep has one per row.
    const surface = fileJournal.sweep({
      label: repo,
      input: process.stdin,
      // `FABRIKA_EDITOR` is the operator's shell's: fabrika loads no `.env` of
      // its own (ADR-0005), so the environment read here is the one it was
      // started in.
      open: editorLauncher(process.env, process.platform),
    });
    const sweepJournal = surface.layer;

    const discovery = Layer.mergeAll(
      sweepJournal,
      gitWorkspace.layer({ repoRoot, dir: repoRoot, base: config.base }).pipe(Layer.provide(platform)),
      // A sweep never reads checks, so there is no reviewer-owned check to
      // exclude; the port is answered rather than made optional (ADR-0002).
      ghForge
        .layer({ repo, base: baseBranch(config.base), cwd: repoRoot })
        .pipe(Layer.provide(Layer.mergeAll(sweepJournal, noReviewer.layer, platform))),
    );

    // The run directory the pull request already has, when it has one: its
    // absence changes nothing but which conversation the merge lands in, so it
    // is best-effort and the key is the fallback.
    const place = (target: SyncTarget): Effect.Effect<Placement> =>
      fileRunStore.runDirectoryFor(home(path, "runs", repoRoot, ""), target.number).pipe(
        Effect.provide(platform),
        Effect.map((found) => ({
          worktree: home(path, "worktrees", repoRoot, target.key),
          log: path.join(found ?? home(path, "runs", repoRoot, target.key), "log.txt"),
        })),
      );

    const worker = (target: SyncTarget, placement: Placement) => {
      // The run directory is the log's own, so the sweep needs no `Path` to
      // hand one across and the two can never point at different directories.
      const runDir = path.dirname(placement.log);
      const foundation = Layer.mergeAll(
        // The row is this worker's address on the sweep's surface, resolved
        // here because the composition root is the one place that knows both
        // which pull request this is and where its tree ended up.
        fileJournal.archiveOnly(placement.log, [surface.row(target.key, placement.worktree)]),
        fileRunStore.layer(runDir),
        fsPrompts.layer({ identifier: target.identifier, title: target.title, base: config.base }),
        gitWorkspace.layer({ repoRoot, dir: placement.worktree, base: config.base }),
      ).pipe(Layer.provide(platform));
      const ports = Layer.mergeAll(
        foundation,
        shellGate.layer(config.gate).pipe(Layer.provide(Layer.merge(foundation, platform))),
        claudeAgent
          .layer({ repoRoot, defaultCwd: placement.worktree, credentials, deny: config.deny, model: config.model })
          .pipe(Layer.provide(Layer.merge(foundation, platform))),
      );
      // The config is the composition root's to know, so the target carries
      // the install command rather than the sweep reading one.
      return syncPullRequest({ ...target, install: config.install }).pipe(Effect.provide(ports));
    };

    return yield* sweep({
      base: config.base,
      concurrency: options.concurrency,
      dryRun: options.dryRun,
      place,
      worker,
    }).pipe(Effect.provide(discovery));
  });
