import { Effect, Layer, Path } from "effect";
import * as claudeAgent from "./adapters/claude-agent.ts";
import * as cubicReviewer from "./adapters/cubic-reviewer.ts";
import * as fileJournal from "./adapters/file-journal.ts";
import * as fileRunStore from "./adapters/file-run-store.ts";
import * as fsPrompts from "./adapters/fs-prompts.ts";
import * as ghForge from "./adapters/gh-forge.ts";
import * as gitWorkspace from "./adapters/git-workspace.ts";
import * as noReviewer from "./adapters/no-reviewer.ts";
import * as shellCaptures from "./adapters/shell-captures.ts";
import * as shellGate from "./adapters/shell-gate.ts";
import { baseBranch, type Config } from "./config.ts";
import type { Credential } from "./infra/claude.ts";
import { isInteractive, openConsole } from "./terminal/console.ts";
import { editorOpener } from "./infra/editor.ts";
import { keepAwake } from "./infra/keep-awake.ts";
import { openScreen } from "./terminal/screen.ts";
import { home } from "./paths.ts";
import { fabrikaPipeline } from "./pipeline/fabrika.ts";
import { Journal } from "./ports/journal.ts";
import { RunContext } from "./ports/run-context.ts";
import { RunStore } from "./ports/run-store.ts";
import type { Ticket } from "./domain/ticket.ts";

export { Escalated } from "./pipeline/escalated.ts";

export type RunOptions = {
  /**
   * Which of the run's steps to include, by name, or every one of them when
   * absent. Decided above this — a flag, or the operator's answer to the
   * select — because a run assembles what it was asked for and does not ask.
   */
  readonly steps?: ReadonlyArray<string>;
};

/** Where one run's two directories are. Both are keyed by repo and ticket, and neither is inside the checkout. */
type Places = {
  /** The git worktree the run works in. */
  readonly dir: string;
  /** `state.json`, `log.txt` and the kept artifacts. */
  readonly runs: string;
  /** The archive, inside `runs`: every event, plain and stamped, whether or not anyone is watching. */
  readonly log: string;
};

const places = (path: Path.Path, repoRoot: string, ticket: Ticket): Places => {
  const runs = home(path, "runs", repoRoot, ticket.identifier);
  return { dir: home(path, "worktrees", repoRoot, ticket.identifier), runs, log: path.join(runs, "log.txt") };
};

/**
 * The surface this run reports to.
 *
 * A run an operator is watching gets the screen; a pipe, `NO_COLOR`,
 * `TERM=dumb` and CI get the scrollback console. Both are named here rather
 * than either being left to the default, because the worktree reaches a
 * presenter through its options and only this knows the path.
 */
const presenter = (ticket: Ticket, dir: string) =>
  isInteractive(process.stdout)
    ? (options: Parameters<typeof openConsole>[0]) =>
        openScreen({
          ...options,
          ticket: ticket.identifier,
          worktree: dir,
          input: process.stdin,
          // `FABRIKA_EDITOR` is the operator's shell's: fabrika loads no
          // `.env` of its own (ADR-0005), so the environment read here is
          // the one it was started in.
          open: editorOpener(dir, process.env, process.platform),
        })
    : (options: Parameters<typeof openConsole>[0]) => openConsole({ ...options, worktree: dir });

/**
 * Everything a run's ports are built on: where it says what it is doing,
 * what it remembers, the prompts filled in for this ticket, the ticket
 * itself, and the tree it works in.
 */
const foundation = (
  config: Config,
  ticket: Ticket,
  { dir, runs, log }: Places,
  repoRoot: string,
) =>
  Layer.mergeAll(
    fileJournal.layer(log, undefined, [], presenter(ticket, dir)),
    fileRunStore.layer(runs),
    fsPrompts.layer({
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description || "(no description)",
      url_line: ticket.url ? `Link: ${ticket.url}` : "",
      type: ticket.type,
      base: config.base,
    }),
    Layer.succeed(RunContext)({ ticket, config }),
    gitWorkspace.layer({ repoRoot, dir, base: config.base }),
  );

/**
 * Assembles one run's ports.
 *
 * This is the only place that knows which adapter is behind each port, which
 * is what makes the rest of it substitutable: a different reviewer, a
 * different code host, a different agent is a different layer here and no
 * change at all to the steps. The layer graph carries the real dependencies —
 * the forge asks the reviewer which checks are the reviewer's own, so it never
 * waits on the signal the review loop is producing.
 */
const ports = (
  config: Config,
  base: ReturnType<typeof foundation>,
  { path, repoRoot, repo, dir, credentials }: {
    readonly path: Path.Path;
    readonly repoRoot: string;
    readonly repo: string;
    readonly dir: string;
    readonly credentials: ReadonlyArray<Credential>;
  },
) => {
  // The one place a provider is named; the review loop reads the port, never this field.
  const reviewer =
    config.review.provider === "cubic" ? cubicReviewer.layer.pipe(Layer.provide(base)) : noReviewer.layer;
  return Layer.mergeAll(
    base,
    shellCaptures
      .layer({ cacheRoot: home(path, "captures", repoRoot, ""), install: config.install })
      .pipe(Layer.provide(base)),
    reviewer,
    ghForge
      .layer({ repo, base: baseBranch(config.base), cwd: repoRoot })
      .pipe(Layer.provide(Layer.merge(base, reviewer))),
    shellGate.layer(config.gate).pipe(Layer.provide(base)),
    claudeAgent
      .layer({ repoRoot, defaultCwd: dir, credentials, deny: config.deny, model: config.model })
      .pipe(Layer.provide(base)),
  );
};

/**
 * One run, assembled and executed.
 *
 * Nothing here decides what the run contains: the steps are `options.steps`
 * or all of them, and everything else is the config's. What this owns is the
 * wiring — which adapter is behind each port, where the run's two directories
 * are, and the two macOS courtesies that are neither.
 */
export const runTicket = (
  config: Config,
  ticket: Ticket,
  credentials: ReadonlyArray<Credential>,
  options: RunOptions = {},
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const repoRoot = process.cwd();
    const at = places(path, repoRoot, ticket);
    // Before the forge layer, because the forge no longer has a `Workspace` to
    // ask: every `gh` call carries `-R`, so where it is spawned is incidental.
    const repo = yield* gitWorkspace.githubRepoAt(repoRoot, config.base);
    const base = foundation(config, ticket, at, repoRoot);
    const layers = ports(config, base, { path, repoRoot, repo, dir: at.dir, credentials });

    return yield* Effect.gen(function* () {
      const store = yield* RunStore;
      const journal = yield* Journal;
      if (store.get().done) {
        return yield* journal.log(`already done: ${ticket.identifier} — remove ${at.runs} to rerun`);
      }
      // After the short-circuit: only a run that is about to wait on something
      // has any reason to hold the machine awake. macOS only, and the run says
      // so once rather than failing: a machine that sleeps is a nuisance, not
      // a wrong result.
      const darwin = process.platform === "darwin";
      if (config.keepAwake && !darwin) {
        yield* journal.log({ kind: "note", level: "warn", text: "keepAwake is macOS-only — ignored here" });
      }
      if (config.keepAwake && darwin) keepAwake(journal.write);
      yield* fabrikaPipeline(config, options.steps).run;
    }).pipe(Effect.provide(layers));
  });
