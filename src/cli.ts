#!/usr/bin/env -S npx tsx
import { Args, Command } from "@effect/cli";
import { FileSystem, Path } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { CONFIG_PATH, CONFIG_TEMPLATE, decodeConfig } from "./config.ts";

const init = Command.make("init", {}, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(process.cwd(), CONFIG_PATH);
    if (yield* fs.exists(target)) {
      return yield* Effect.fail(new Error(`${CONFIG_PATH} already exists — edit it instead.`));
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

const run = Command.make("run", { ticket: Args.text({ name: "ticket" }) }, ({ ticket }) =>
  Effect.fail(new Error(`fabrika run ${ticket}: not implemented yet (PLAN.md step 4)`)),
);

const fabrika = Command.make("fabrika").pipe(Command.withSubcommands([init, run]));

Command.run(fabrika, { name: "fabrika", version: "0.1.0" })(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
);
