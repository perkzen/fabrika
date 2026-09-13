import { Effect, Layer, Path } from "effect";
import { homedir } from "node:os";
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
import type { Config } from "./config.ts";
import type { Credential } from "./infra/claude.ts";
import { fabrikaPipeline } from "./pipeline/fabrika.ts";
import { Journal } from "./ports/journal.ts";
import { RunContext } from "./ports/run-context.ts";
import { RunStore } from "./ports/run-store.ts";
import type { Ticket } from "./ticket.ts";

export { Escalated } from "./pipeline/escalated.ts";

/**
 * Where a run keeps what it must not lose: state, logs and raw transcripts
 * outside the target repo, the worktree outside it as well. Both are keyed by
 * repository and ticket, so two tickets never share either. The capture cache
 * is keyed by repository and base sha instead, so ten tickets cut from one
 * base share it.
 */
const home = (kind: "runs" | "worktrees" | "captures", repoRoot: string, identifier: string) =>
  Effect.map(Path.Path, (path) => path.join(homedir(), ".fabrika", kind, path.basename(repoRoot), identifier));

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
    const dir = yield* home("worktrees", repoRoot, ticket.identifier);
    const runsDir = yield* home("runs", repoRoot, ticket.identifier);

    const foundation = Layer.mergeAll(
      fileJournal.layer(path.join(runsDir, "log.txt")),
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
        .layer({ cacheRoot: yield* home("captures", repoRoot, ""), install: config.install })
        .pipe(Layer.provide(foundation)),
      reviewer,
      ghForge.layer({ base: gitWorkspace.baseBranch(config.base) }).pipe(Layer.provide(Layer.merge(foundation, reviewer))),
      shellGate.layer(config.gate).pipe(Layer.provide(foundation)),
      claudeAgent.layer({ repoRoot, defaultCwd: dir, credentials, deny: config.deny }).pipe(Layer.provide(foundation)),
    );

    return yield* Effect.gen(function* () {
      const store = yield* RunStore;
      const journal = yield* Journal;
      if (store.get().done) {
        return yield* journal.log(`already done: ${ticket.identifier} — remove ${runsDir} to rerun`);
      }
      yield* fabrikaPipeline(config).run;
    }).pipe(Effect.provide(ports));
  });
