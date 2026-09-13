import { NodeServices } from "@effect/platform-node";
import { Effect, PlatformError } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runClaudeWithFallback } from "../src/infra/claude.ts";
import type { RunEvent } from "../src/run-event.ts";

/**
 * A spawner that refuses to spawn, so what a call says before the subprocess
 * is observable without simulating one. It fails typed rather than dying:
 * `ClaudeError` already includes `PlatformError`, so the failure lands in the
 * error channel the caller matches on instead of escaping as a defect.
 */
const refuses = ChildProcessSpawner.make(() =>
  Effect.fail(
    PlatformError.badArgument({
      module: "ChildProcessSpawner",
      method: "spawn",
      description: "the test never spawns",
    }),
  ),
);

/** Runs the call far enough to hear it speak, and returns what it said. */
const spoke = (model?: string) => {
  const events: Array<RunEvent> = [];
  return Effect.runPromise(
    runClaudeWithFallback({
      cwd: "/repo",
      prompt: "hello",
      model,
      credentials: [{ name: "default", env: {} }],
      onEvent: (event) => void events.push(event),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, refuses),
      Effect.provide(NodeServices.layer),
      Effect.match({ onSuccess: () => events, onFailure: () => events }),
    ),
  );
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
    (await spoke("opus")).map((event) => (event.kind === "note" ? event.text : event.kind)),
    ["[model] opus", "[credential] default"],
    "the model is the call's, the credential an attempt within it, so the model is said first",
  );

  assert.deepEqual(
    (await spoke()).map((event) => (event.kind === "note" ? event.text : event.kind)),
    ["[credential] default"],
    "fabrika has nothing true to say about what the CLI's own default was",
  );
});
