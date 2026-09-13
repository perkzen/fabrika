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
import { isInteractive } from "./infra/console.ts";
import { keepAwake } from "./infra/keep-awake.ts";
import { notifierApp } from "./infra/notifier-app.ts";
import { openNotifier } from "./infra/notifier.ts";
import { openScreen } from "./infra/screen.ts";
import { home } from "./paths.ts";
import { fabrikaPipeline } from "./pipeline/fabrika.ts";
import { Journal } from "./ports/journal.ts";
import { RunContext } from "./ports/run-context.ts";
import { RunStore } from "./ports/run-store.ts";
import type { Ticket } from "./ticket.ts";

export { Escalated } from "./pipeline/escalated.ts";

/**
 * Assembles one run and executes it.
 *
 * This is the only place that knows which adapter is behind each port, which
 * is what makes the rest of it substitutable: a different reviewer, a
 * different code host, a different agent is a different layer here and no
 * change at all to the steps. The layer graph carries the real dependencies —
 * the forge asks the reviewer which checks are the reviewer's own, so it never
 * waits on the signal the review loop is producing.
 */
export const runTicket = (config: Config, ticket: Ticket, credentials: ReadonlyArray<Credential>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const repoRoot = process.cwd();
    const dir = home(path, "worktrees", repoRoot, ticket.identifier);
    // Before the forge layer, because the forge no longer has a `Workspace` to
    // ask: every `gh` call carries `-R`, so where it is spawned is incidental.
    const repo = yield* gitWorkspace.githubRepoAt(repoRoot, config.base);
    const runsDir = home(path, "runs", repoRoot, ticket.identifier);

    // macOS only, both of them, and the run says so once rather than failing:
    // a machine that sleeps or a notification that never arrives is a
    // nuisance, not a wrong result.
    const darwin = process.platform === "darwin";
    // Built before the journal exists, because the journal is one of the
    // surfaces it is built for; what it has to say is held and logged below.
    const app = config.notify && darwin ? yield* notifierApp : undefined;
    const notifier = app?.bin ? [openNotifier({ title: `Fabrika ${ticket.identifier}`, bin: app.bin })] : [];

    const foundation = Layer.mergeAll(
      // A run an operator is watching gets the screen; a pipe, `NO_COLOR`,
      // `TERM=dumb` and CI get the scrollback console the default supplies.
      fileJournal.layer(
        path.join(runsDir, "log.txt"),
        undefined,
        notifier,
        isInteractive(process.stdout)
          ? (options) => openScreen({ ...options, ticket: ticket.identifier, input: process.stdin })
          : undefined,
      ),
      fileRunStore.layer(runsDir),
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
    // The one place a provider is named; the review loop reads the port, never this field.
    const reviewer =
      config.review.provider === "cubic" ? cubicReviewer.layer.pipe(Layer.provide(foundation)) : noReviewer.layer;
    const ports = Layer.mergeAll(
      foundation,
      shellCaptures
        .layer({ cacheRoot: home(path, "captures", repoRoot, ""), install: config.install })
        .pipe(Layer.provide(foundation)),
      reviewer,
      ghForge
        .layer({ repo, base: baseBranch(config.base), cwd: repoRoot })
        .pipe(Layer.provide(Layer.merge(foundation, reviewer))),
      shellGate.layer(config.gate).pipe(Layer.provide(foundation)),
      claudeAgent.layer({ repoRoot, defaultCwd: dir, credentials, deny: config.deny }).pipe(Layer.provide(foundation)),
    );

    return yield* Effect.gen(function* () {
      const store = yield* RunStore;
      const journal = yield* Journal;
      if (store.get().done) {
        return yield* journal.log(`already done: ${ticket.identifier} — remove ${runsDir} to rerun`);
      }
      // After the short-circuit: only a run that is about to wait on something
      // has any reason to hold the machine awake, and only one that starts is
      // worth a notification when it ends.
      if ((config.keepAwake || config.notify) && !darwin) {
        yield* journal.log({ kind: "note", level: "warn", text: "keepAwake and notify are macOS-only — ignored here" });
      }
      if (config.keepAwake && darwin) keepAwake(journal.write);
      if (app?.note) yield* journal.log({ kind: "note", level: "detail", text: app.note });
      yield* fabrikaPipeline(config).run;
    }).pipe(Effect.provide(ports));
  });
