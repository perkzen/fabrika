import assert from "node:assert/strict";
import { test } from "node:test";
import { runClaudeWithFallback } from "../src/infra/claude.ts";
import type { RunEvent } from "../src/run-event.ts";

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
