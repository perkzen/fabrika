#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Path } from "effect";
import { CliError, Command, Flag } from "effect/unstable/cli";
import * as fileJournal from "./adapters/file-journal.ts";
import * as fileTickets from "./adapters/file-tickets.ts";
import { runClaude } from "./infra/claude.ts";
import { CONFIG_PATH, loadConfig, type Config } from "./config.ts";
import { asConfig, proposeConfig } from "./configure.ts";
import { FabrikaError } from "./errors.ts";
import { runTicket } from "./run.ts";
import { runSweep } from "./sweep.ts";
import { selectSteps } from "./terminal/select.ts";
import { choices, unknown } from "./domain/choices.ts";
import { banner, VERSION } from "./terminal/banner.ts";
import { Journal } from "./ports/journal.ts";
import type { RunEvent } from "./domain/run-event.ts";
import { exec } from "./infra/shell.ts";

const credentials = [{ name: "default", env: {} }];

/**
 * `init` has no run directory to mirror into, so its journal is the console
 * alone — and through the port, like everything else that says anything: it
 * gets the same colour, the same markdown and the same height cap as a stage,
 * and the layer's own finaliser restores the cursor. `init` can fail with
 * `FabrikaError`, and a cursor left hidden past the end of the process is the
 * one failure that damages the operator's terminal.
 */
const init = Command.make("init", {}, () =>
  Effect.suspend(() => {
    banner({ stream: process.stdout, version: VERSION });
    return configure.pipe(Effect.provide(fileJournal.consoleOnly()));
  }),
);

const configure = Effect.gen(function* () {
  const journal = yield* Journal;
  const say = (entry: RunEvent | string) => journal.log(entry);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(process.cwd(), CONFIG_PATH);
  if (yield* fs.exists(target)) {
    return yield* new FabrikaError({ message: `${CONFIG_PATH} already exists — edit it instead.` });
  }
  // The gate is whatever this repo already checks with, so it is read off
  // the repo rather than shipped: a step that does not exist here would go
  // red on an untouched checkout, and the agent would be handed "fix it"
  // for code it never wrote. One structured call proposes the four
  // repo-specific fields; the host is still the one that writes the file,
  // so a rejected answer cannot produce a config that will not load.
  yield* say("reading the repo: base branch, install command, the checks CI enforces, and the review bot.");
  yield* say("this runs the candidate commands, so give it a minute.");
  const rejected = (message: string) => say({ kind: "note", level: "warn", text: message }).pipe(Effect.as(null));
  const proposal = yield* proposeConfig(process.cwd(), credentials[0]!, journal.write).pipe(
    Effect.catchTag("AgentUnauthorized", (e) => rejected(`claude cannot authenticate (${e.message.slice(0, 80)}) — run \`claude auth login\``)),
    Effect.catchTag("AgentRateLimited", () => rejected("usage limit hit")),
    Effect.catchTag("AgentFailed", (e) => rejected(`the configure call failed (exit ${e.exitCode}${e.message ? `: ${e.message.slice(0, 80)}` : ""})`)),
    // What is left is a filesystem or spawn failure — `claude` missing from
    // PATH is the usual one. `init` still has a config to write, so it says
    // what went wrong and writes the neutral one rather than dying.
    Effect.catch((e) => rejected(`could not run the configure call (${String((e as { message?: unknown }).message ?? e).slice(0, 80)})`)),
  );
  for (const note of proposal?.notes ?? []) yield* say({ kind: "note", level: "detail", text: note });
  const config = asConfig(proposal);
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFileString(target, JSON.stringify(config, null, 2) + "\n");
  // `JSON.stringify` expands every array; prettier collapses the short ones,
  // so a repo whose gate runs `prettier --check .` would fail on its own
  // config. Format it with the target repo's prettier — its config, its
  // rules — and shrug if there isn't one: the file is valid JSON either way.
  const prettier = path.join(process.cwd(), "node_modules", ".bin", "prettier");
  if (yield* fs.exists(prettier)) yield* exec(process.cwd(), [prettier, "--write", CONFIG_PATH]).pipe(Effect.ignore);
  yield* say(`wrote ${CONFIG_PATH}`);
  if (!proposal) {
    yield* say("`gate` is empty — fill in the commands this repo checks with before running a ticket.");
    yield* say("`review.provider` is `none` — set it to `cubic` if this repo has the cubic review bot.");
  }
  yield* say("read the gate before you commit the file: it is what every code stage must pass.");
  yield* say("edit: branch, and the mcp names each stage may use.");
  yield* say("mcp names must match `claude mcp list` in this repo; remote servers need a static header.");
});

/**
 * A stale keychain token fails every `claude -p` while `claude auth status`
 * still says logged in (seen 2026-09-10 with the desktop app signed in). One cheap call up front beats
 * dying in the plan stage.
 */
const authProbe = runClaude({ cwd: process.cwd(), prompt: "Reply with exactly: OK", credential: credentials[0]! }).pipe(
  Effect.catchTag("AgentUnauthorized", (e) =>
    new FabrikaError({ message: `claude cannot authenticate (${e.message.slice(0, 120)}) — run \`claude auth login\` in a terminal` }),
  ),
  Effect.asVoid,
);

/**
 * Which of a run's steps this invocation runs, or `undefined` for all of them.
 *
 * Three inputs and one rule: `--steps` wins wherever it is given, because a
 * flag is the answer already written down; a terminal with nobody piping it
 * is asked; everything else — a pipe, `NO_COLOR`, CI, an agent's shell —
 * runs the whole pipeline, which is what it has always run. The select never
 * renders on a surface that cannot answer it, so a scheduled `fabrika run`
 * cannot hang on a question.
 */
const chooseSteps = (config: Config, flag: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isSome(flag)) {
      const asked = flag.value
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      const strangers = unknown(config, asked);
      if (strangers.length > 0) {
        return yield* new FabrikaError({
          message: `--steps: no step called ${strangers.join(", ")} — this repo runs ${choices(config)
            .map((choice) => choice.name)
            .join(", ")}`,
        });
      }
      return asked;
    }
    return yield* selectSteps(config, { stream: process.stdout, input: process.stdin });
  });

/**
 * A run's ticket is a markdown file, and only a markdown file.
 *
 * Linear still reaches a run — through the `linear-ro` MCP server a stage
 * declares, which is the agent reading the issue, its comments and its linked
 * issues at the point it needs them. That is strictly more than the host's own
 * GraphQL fetch ever got, and it costs no API key: the server's credential is
 * registered once with `claude mcp add`, so fabrika holds no secret, loads no
 * `.env`, and has nothing to leak into a worktree or a capture. A file's
 * `linear:` frontmatter is what still puts the issue's identifier on the
 * branch and its URL in the pull request.
 */
const run = Command.make(
  "run",
  {
    file: Flag.File("file").pipe(Flag.withDescription("the markdown spec to run, e.g. .fabrika/tickets/FAB-7.md")),
    // Comma-separated rather than repeated, so the whole answer is one
    // argument an agent can build from `--help` and a schedule can carry in
    // one string.
    steps: Flag.String("steps").pipe(
      Flag.withDescription("comma-separated steps to run, e.g. implement,security,pull-request; asks when omitted on a terminal, runs all of them otherwise"),
      Flag.withMetavar("names"),
      Flag.optional,
    ),
  },
  ({ file, steps }) =>
    Effect.gen(function* () {
      banner({ stream: process.stdout, version: VERSION });
      const config = yield* loadConfig(process.cwd());
      // Before the auth probe and the ticket read: the operator is at the
      // keyboard now, and asking them to watch a liveness call first is
      // asking them to wait for nothing.
      const chosen = yield* chooseSteps(config, steps).pipe(
        // `^C` at the select is the operator leaving before the run began:
        // no stack trace, and the shell's own code for it rather than `0`,
        // because `fabrika run` exiting 0 is what a caller reads as a run
        // that finished.
        Effect.catchTag("Cancelled", () => Effect.sync(() => process.exit(130))),
      );
      yield* authProbe;
      const record = yield* fileTickets.source(file).fetch;
      yield* runTicket(config, record, credentials, { steps: chosen }).pipe(
        Effect.catchTag("Escalated", (e) =>
          Console.error(
            [
              `ESCALATED: ${e.reason}`,
              ...(e.prUrl ? [`  PR: ${e.prUrl}`] : []),
              `  rerun the same command to resume from where it stopped.`,
            ].join("\n"),
          ).pipe(Effect.andThen(Effect.sync(() => process.exit(2)))),
        ),
        Effect.catchTag("AgentRateLimited", () =>
          Console.error("usage limit hit — state is saved; rerun the same command once the window resets").pipe(
            Effect.andThen(Effect.sync(() => process.exit(3))),
          ),
        ),
      );
    }),
);

/**
 * One sweep over the operator's open pull requests. `--concurrency` is a flag
 * rather than a config field: `.fabrika/config.json` is committed and shared
 * by everyone who runs fabrika in that repo, and how much of one person's
 * Claude budget a sweep may spend is theirs per invocation, not repo policy.
 */
const sync = Command.make(
  "sync",
  {
    // Defaulted, not bare: a `Flag.Boolean` with no default is *required*, so
    // `fabrika sync` — the form the README documents and a schedule invokes —
    // died on "Missing required flag: --dry-run".
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("print the selection and change nothing"),
      Flag.withDefault(false),
    ),
    concurrency: Flag.Int("concurrency").pipe(
      Flag.withDescription("how many pull requests to sync at once"),
      Flag.withDefault(2),
    ),
  },
  ({ dryRun, concurrency }) =>
    Effect.gen(function* () {
      // `Flag` has no numeric minimum — `Flag.atLeast` is about how often a
      // flag repeats — so the handler checks, and a CLI error is exit 1.
      if (concurrency < 1) return yield* new FabrikaError({ message: "--concurrency must be at least 1" });
      const config = yield* loadConfig(process.cwd());
      // A dry run spawns no agent, so it needs no credential: the point of it
      // is that it is the cheapest, safest thing to reach for first.
      if (!dryRun) yield* authProbe;
      const { exitCode } = yield* runSweep(config, credentials, { dryRun, concurrency });
      // Outside `runSweep`, so the presenter's `ensuring` has already
      // restored the cursor — the same shape `run` uses around `runTicket`.
      if (exitCode !== 0) yield* Effect.sync(() => process.exit(exitCode));
    }),
);

const fabrika = Command.make("fabrika").pipe(Command.withSubcommands([init, run, sync]));

fabrika.pipe(
  Command.run({ version: VERSION }),
  // `Command.run` has already rendered usage and help for its own errors, so
  // those are rethrown untouched; everything else is one of ours and gets a
  // single line instead of a stack trace.
  Effect.catch((e) => {
    if (CliError.isCliError(e)) return Effect.fail(e);
    const tag = (e as { _tag?: string })._tag ?? "Error";
    const detail = "message" in (e as object) ? String((e as { message: unknown }).message) : JSON.stringify(e);
    return Console.error(`${tag}: ${detail}`).pipe(Effect.andThen(Effect.sync(() => process.exit(1))));
  }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
