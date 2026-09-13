import { NodeServices } from "@effect/platform-node";
import { Effect, Sink, Stream } from "effect";
import { ChildProcessSpawner, type ChildProcess } from "effect/unstable/process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runClaudeWithFallback } from "../src/infra/claude.ts";
import type { RunEvent } from "../src/run-event.ts";

/**
 * The spawner seam's second adapter: it keeps the command it was handed and
 * answers as a `claude` that said one thing and exited cleanly.
 *
 * This is what makes the seam a seam. A spawner that only refused could show
 * what a call *said* before spawning; this one also shows what it spawned, so
 * the flags fabrika builds — which are otherwise trusted rather than tested —
 * are assertable without a real binary.
 */
const spawner = (spawned: Array<ChildProcess.StandardCommand>) =>
  ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag === "StandardCommand") spawned.push(command);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.fromArray([new TextEncoder().encode('{"type":"result","result":"ok"}\n')]),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );

/** Runs one call against the fake and returns both halves: what it said, and what it spawned. */
const ran = async (model?: string) => {
  const events: Array<RunEvent> = [];
  const spawned: Array<ChildProcess.StandardCommand> = [];
  await Effect.runPromise(
    runClaudeWithFallback({
      cwd: "/repo",
      prompt: "hello",
      model,
      credentials: [{ name: "default", env: {} }],
      onEvent: (event) => void events.push(event),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(spawned)),
      Effect.provide(NodeServices.layer),
    ),
  );
  return { events, args: spawned[0]?.args ?? [] };
};

/**
 * Construction only — nothing here runs the effect, which is the whole point:
 * a wait brackets the effect it is handed, so anything the call says before
 * the effect is run lands above the wait it belongs under.
 */
test("building the call says nothing; the credential is named once it runs", () => {
  const said: Array<RunEvent> = [];
  runClaudeWithFallback({
    cwd: "/repo",
    prompt: "hello",
    credentials: [{ name: "default", env: {} }],
    onEvent: (event) => void said.push(event),
  });

  assert.deepEqual(said, [], "a function returning an effect must not speak when it is called");
});

test("the model is named once, before the credential, and only when one was asked for", async () => {
  assert.deepEqual(
    (await ran("opus")).events.map((event) => (event.kind === "note" ? event.text : event.kind)),
    ["[model] opus", "[credential] default"],
    "the model is the call's, the credential an attempt within it, so the model is said first",
  );

  assert.deepEqual(
    (await ran()).events.map((event) => (event.kind === "note" ? event.text : event.kind)),
    ["[credential] default"],
    "fabrika has nothing true to say about what the CLI's own default was",
  );
});

test("the model the config named reaches the CLI as --model, and naming none passes no flag", async () => {
  const { args } = await ran("opus");
  assert.equal(args.filter((arg) => arg === "--model").length, 1);
  assert.equal(args[args.indexOf("--model") + 1], "opus", "passed verbatim; the CLI is the authority on what it means");

  const { args: unset } = await ran();
  assert.ok(!unset.includes("--model"), "so a repository that never mentions models runs exactly as it did");
});
