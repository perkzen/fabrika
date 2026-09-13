import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import * as shellGate from "../src/adapters/shell-gate.ts";
import type { GateStep } from "../src/config.ts";
import { Gate } from "../src/ports/gate.ts";
import type { RunEvent } from "../src/run-event.ts";
import { harness } from "./harness.ts";

/** `true` and `false` are the cheapest deterministic commands there are, so `(0s)` is stable. */
const steps: ReadonlyArray<GateStep> = [
  { name: "docs", run: "true", when: ["docs/**"] },
  { name: "compile", run: "true" },
  { name: "lint", run: "false" },
];

test("a gate reports step n of N and its skipped steps still advance the count", async () => {
  const world = harness({ dir: process.cwd() });
  const failure = await Effect.runPromise(
    Effect.flatMap(Gate, (gate) => gate.check).pipe(
      Effect.provide(shellGate.layer(steps).pipe(Layer.provide(Layer.merge(world.layer, NodeServices.layer)))),
      Effect.orDie,
    ),
  );

  assert.equal(failure?.name, "lint");
  assert.deepEqual(
    world.recording.events
      .filter((entry): entry is Extract<RunEvent, { kind: "gate" }> => typeof entry !== "string" && entry.kind === "gate")
      .map((event) => [event.name, event.at, event.of, event.state]),
    [
      ["docs", 1, 3, "skipped"],
      ["compile", 2, 3, "start"],
      ["compile", 2, 3, "pass"],
      ["lint", 3, 3, "start"],
      ["lint", 3, 3, "fail"],
    ],
    "a skipped step advances the count like every other",
  );
  assert.deepEqual(world.recording.log, [
    "gate docs: skipped (no matching changes)",
    "gate compile: true",
    "gate compile: ok (0s)",
    "gate lint: false",
    "gate lint: FAILED (exit 1, 0s)",
  ]);
});
