#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Path } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fileTickets from "./adapters/file-tickets.ts";
import * as linearTickets from "./adapters/linear-tickets.ts";
import { runClaude } from "./infra/claude.ts";
import { CONFIG_PATH, loadConfig } from "./config.ts";
import { asConfig, proposeConfig } from "./configure.ts";
import { FabrikaError } from "./errors.ts";
import { runTicket } from "./run.ts";
import { runSweep } from "./sweep.ts";
import { openConsole, type Presenter } from "./infra/console.ts";
import { banner } from "./infra/banner.ts";
import type { RunEvent } from "./run-event.ts";
import { exec } from "./infra/shell.ts";

const credentials = [{ name: "default", env: {} }];

/**
 * `init` has no run directory and no `Journal`, which is the whole reason the
 * presenter takes a stream: it gets the same colour, the same markdown and
 * the same height cap as a stage. `ensuring` rather than a plain return —
 * `init` can fail with `FabrikaError`, and a cursor left hidden past the end
 * of the process is the one failure that damages the operator's terminal.
 */
const init = Command.make("init", {}, () =>
  Effect.suspend(() => {
    banner({ stream: process.stdout, version: VERSION });
    const presenter = openConsole({ stream: process.stdout });
    return configure(presenter).pipe(Effect.ensuring(Effect.sync(presenter.end)));
  }),
);

const configure = (presenter: Presenter) =>
  Effect.gen(function* () {
    const say = (entry: RunEvent | string) => Effect.sync(() => presenter.show(entry));
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
    const proposal = yield* proposeConfig(process.cwd(), credentials[0]!, presenter.show).pipe(
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
 * Read rather than hard-coded: the two drifted once already, and `npm version`
 * only bumps package.json and the plugin manifest.
 */
const VERSION = ((): string => {
  const pkg: unknown = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  return typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string" ? pkg.version : "0.0.0";
})();

/** Secrets live outside the target repo; loaded by explicit path, no dotenv. */
const ENV_FILE = join(homedir(), ".config", "fabrika", ".env");

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

const run = Command.make(
  "run",
  {
    ticket: Argument.String("ticket").pipe(Argument.withDescription("a Linear identifier, e.g. PAR-123"), Argument.optional),
    file: Flag.File("file").pipe(Flag.withDescription("a local markdown spec instead of a Linear issue"), Flag.optional),
  },
  ({ ticket, file }) =>
    Effect.gen(function* () {
      banner({ stream: process.stdout, version: VERSION });
      if (Option.isSome(ticket) === Option.isSome(file)) {
        return yield* new FabrikaError({ message: "give exactly one of: a Linear identifier, or --file <spec.md>" });
      }
      if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
      const config = yield* loadConfig(process.cwd());
      yield* authProbe;
      const record = Option.isSome(file)
        ? yield* fileTickets.source(file.value).fetch
        : yield* Effect.gen(function* () {
            const key = process.env.LINEAR_API_KEY;
            if (!key) return yield* new FabrikaError({ message: `LINEAR_API_KEY is not set; put it in ${ENV_FILE}` });
            return yield* linearTickets.source(Option.getOrThrow(ticket), key).fetch;
          });
      yield* runTicket(config, record, credentials).pipe(
        Effect.catchTag("Escalated", (e) =>
          Console.error(
            [
              // Where the worktree is was said by the presenter on the way
              // out, whichever surface the run had; saying it again here
              // would be the second copy of the same line.
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
      if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
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
