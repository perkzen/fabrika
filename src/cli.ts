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
import type { Config } from "./config.ts";
import { CONFIG_PATH, CONFIG_TEMPLATE, loadConfig } from "./config.ts";
import { proposeConfig } from "./configure.ts";
import { FabrikaError } from "./errors.ts";
import { runTicket } from "./run.ts";
import { plain } from "./run-event.ts";
import { exec } from "./infra/shell.ts";

const credentials = [{ name: "default", env: {} }];

const init = Command.make("init", {}, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(process.cwd(), CONFIG_PATH);
    if (yield* fs.exists(target)) {
      return yield* new FabrikaError({ message: `${CONFIG_PATH} already exists — edit it instead.` });
    }
    // The gate is whatever this repo already checks with, so it is read off
    // the repo rather than shipped: a step that does not exist here would go
    // red on an untouched checkout, and the agent would be handed "fix it"
    // for code it never wrote. One structured call proposes the three
    // repo-specific fields; the host is still the one that writes the file,
    // so a rejected answer cannot produce a config that will not load.
    yield* Console.log("reading the repo: base branch, install command, and the checks CI enforces.");
    yield* Console.log("this runs the candidate commands, so give it a minute.");
    const rejected = (message: string) => Console.log(`  ${message}`).pipe(Effect.as(null));
    const proposal = yield* proposeConfig(process.cwd(), credentials[0]!, (event) => {
      for (const line of plain(event)) console.log(line);
    }).pipe(
      Effect.catchTag("AgentUnauthorized", (e) => rejected(`claude cannot authenticate (${e.message.slice(0, 80)}) — run \`claude auth login\``)),
      Effect.catchTag("AgentRateLimited", () => rejected("usage limit hit")),
      Effect.catchTag("AgentFailed", (e) => rejected(`the configure call failed (exit ${e.exitCode}${e.message ? `: ${e.message.slice(0, 80)}` : ""})`)),
      // What is left is a filesystem or spawn failure — `claude` missing from
      // PATH is the usual one. `init` still has a config to write, so it says
      // what went wrong and writes the neutral one rather than dying.
      Effect.catch((e) => rejected(`could not run the configure call (${String((e as { message?: unknown }).message ?? e).slice(0, 80)})`)),
    );
    for (const note of proposal?.notes ?? []) yield* Console.log(`  ${note}`);
    const config: Config = proposal
      ? { ...CONFIG_TEMPLATE, base: proposal.base, install: proposal.install, gate: proposal.gate }
      : CONFIG_TEMPLATE;
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, JSON.stringify(config, null, 2) + "\n");
    // `JSON.stringify` expands every array; prettier collapses the short ones,
    // so a repo whose gate runs `prettier --check .` would fail on its own
    // config. Format it with the target repo's prettier — its config, its
    // rules — and shrug if there isn't one: the file is valid JSON either way.
    const prettier = path.join(process.cwd(), "node_modules", ".bin", "prettier");
    if (yield* fs.exists(prettier)) yield* exec(process.cwd(), [prettier, "--write", CONFIG_PATH]).pipe(Effect.ignore);
    yield* Console.log(`wrote ${CONFIG_PATH}`);
    if (!proposal) {
      yield* Console.log("`gate` is empty — fill in the commands this repo checks with before running a ticket.");
    }
    yield* Console.log("read the gate before you commit the file: it is what every code stage must pass.");
    yield* Console.log("edit: branch, and the mcp names each stage may use.");
    yield* Console.log("mcp names must match `claude mcp list` in this repo; remote servers need a static header.");
  }),
);

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
              `ESCALATED: ${e.reason}`,
              `  worktree: ${e.worktree}`,
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

const fabrika = Command.make("fabrika").pipe(Command.withSubcommands([init, run]));

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
