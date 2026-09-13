import { NodeServices } from "@effect/platform-node";
import { Effect, Sink, Stream } from "effect";
import { ChildProcessSpawner, type ChildProcess } from "effect/unstable/process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runClaudeWithFallback, type Credential } from "../src/infra/claude.ts";
import type { RunEvent } from "../src/run-event.ts";

const RESULT = '{"type":"result","result":"ok"}\n';
/** What the CLI says when the credential is out of budget; `runClaude` reads it as a rate limit and falls back. */
const RATE_LIMITED = '{"type":"system","subtype":"api_retry","error":"rate_limit"}\n' + RESULT;

/**
 * The spawner seam's second adapter: it keeps the command it was handed and
 * answers as a `claude` that said what `script` tells it to and exited
 * cleanly, so the flags fabrika builds are assertable without a real binary.
 */
const spawner = (spawned: Array<ChildProcess.StandardCommand>, script: ReadonlyArray<string>) =>
  ChildProcessSpawner.make((command) => {
    // Read before the push, so the nth spawn gets the nth scripted answer.
    const stdout = script[spawned.length] ?? RESULT;
    return Effect.sync(() => {
      if (command._tag === "StandardCommand") spawned.push(command);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.fromArray([new TextEncoder().encode(stdout)]),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    });
  });

/** Runs one call against the fake and returns both halves: what it said, and what it spawned. */
const ran = async (
  model?: string,
  credentials: ReadonlyArray<Credential> = [{ name: "default", env: {} }],
  script: ReadonlyArray<string> = [],
) => {
  const events: Array<RunEvent> = [];
  const spawned: Array<ChildProcess.StandardCommand> = [];
  await Effect.runPromise(
    runClaudeWithFallback({
      cwd: "/repo",
      prompt: "hello",
      model,
      credentials,
      onEvent: (event) => void events.push(event),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(spawned, script)),
      Effect.provide(NodeServices.layer),
    ),
  );
  return { events, said: events.map((event) => (event.kind === "note" ? event.text : event.kind)), args: spawned[0]?.args ?? [] };
};

/**
 * Construction only — nothing here runs the effect, which is the whole point:
 * a wait brackets the effect it is handed, so anything the call says before
 * the effect is run lands above the wait it belongs under.
 */
test("building the call says nothing; the credential and the model are named once it runs", () => {
  const said: Array<RunEvent> = [];
  runClaudeWithFallback({
    cwd: "/repo",
    prompt: "hello",
    // Named here so that emitting it anywhere but inside the suspend callback
    // is caught: the model is the first thing the call says, and the earliest
    // thing that could escape the wait it belongs under.
    model: "opus",
    credentials: [{ name: "default", env: {} }],
    onEvent: (event) => void said.push(event),
  });

  assert.deepEqual(said, [], "a function returning an effect must not speak when it is called");
});

test("the model is named once, before the credential, and only when one was asked for", async () => {
  assert.deepEqual(
    (await ran("opus")).said,
    ["[model] opus", "[credential] default"],
    "the model is the call's, the credential an attempt within it, so the model is said first",
  );

  assert.deepEqual(
    (await ran()).said,
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

test("the model is named once for the call, however many credentials the call burns through", async () => {
  const { said } = await ran("opus", [{ name: "first", env: {} }, { name: "second", env: {} }], [RATE_LIMITED]);

  assert.deepEqual(said, [
    "[model] opus",
    "[credential] first",
    "[retry] rate_limit",
    "[credential] first exhausted (AgentRateLimited), trying the next one",
    "[credential] second",
  ]);
  assert.equal(
    said.filter((text) => text.startsWith("[model]")).length,
    1,
    "a credential swap reports the thing that changed, not the thing that did not",
  );
});
