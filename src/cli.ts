#!/usr/bin/env -S npx tsx
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Path } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runClaude } from "./claude.ts";
import { CONFIG_PATH, CONFIG_TEMPLATE, decodeConfig, loadConfig } from "./config.ts";
import { FabrikaError } from "./errors.ts";
import { runTicket } from "./run.ts";
import { fromFile, fromLinear } from "./ticket.ts";

const init = Command.make("init", {}, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(process.cwd(), CONFIG_PATH);
    if (yield* fs.exists(target)) {
      return yield* new FabrikaError({ message: `${CONFIG_PATH} already exists — edit it instead.` });
    }
    // The template is decoded before it is written, so it can never drift
    // from the schema without `init` itself failing.
    yield* decodeConfig(CONFIG_TEMPLATE);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, CONFIG_TEMPLATE);
    yield* Console.log(`wrote ${CONFIG_PATH}`);
    yield* Console.log("edit: base, branch, gate commands, and the mcp names each stage may use.");
    yield* Console.log("mcp names must match `claude mcp list` in this repo; remote servers need a static header.");
  }),
);

/** Secrets live outside the target repo; loaded by explicit path, no dotenv. */
const ENV_FILE = join(homedir(), ".config", "fabrika", ".env");

const credentials = [{ name: "default", env: {} }];

/**
 * A stale keychain token fails every `claude -p` while `claude auth status`
 * still says logged in (seen 2026-09-10 with the desktop app signed in). One cheap call up front beats
 * dying in the plan stage.
 */
const authProbe = runClaude({ cwd: process.cwd(), prompt: "Reply with exactly: OK", credential: credentials[0]! }).pipe(
  Effect.catchTag("ClaudeAuthError", (e) =>
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
        ? yield* fromFile(file.value)
        : yield* Effect.gen(function* () {
            const key = process.env.LINEAR_API_KEY;
            if (!key) return yield* new FabrikaError({ message: `LINEAR_API_KEY is not set; put it in ${ENV_FILE}` });
            return yield* fromLinear(Option.getOrThrow(ticket), key);
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
        Effect.catchTag("ClaudeRateLimited", () =>
          Console.error("usage limit hit — state is saved; rerun the same command once the window resets").pipe(
            Effect.andThen(Effect.sync(() => process.exit(3))),
          ),
        ),
      );
    }),
);

const fabrika = Command.make("fabrika").pipe(Command.withSubcommands([init, run]));

fabrika.pipe(
  Command.run({ version: "0.1.0" }),
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
