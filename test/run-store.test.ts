import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";
import * as fileRunStore from "../src/adapters/file-run-store.ts";
import { RunStore, type RunState } from "../src/ports/run-store.ts";

/** The real adapter against a real directory: the run's memory is the one thing a resume cannot do without. */
const inDirectory = <A>(directory: string, use: (store: RunStore) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* RunStore);
    }).pipe(Effect.provide(fileRunStore.layer(directory)), Effect.provide(NodeServices.layer), Effect.orDie) as Effect.Effect<A>,
  );

test("a change is on disk before the effect completes, and a later run reads it back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fabrika-store-"));

  await inDirectory(directory, (store) =>
    Effect.gen(function* () {
      yield* store.update((state) => void (state.sessions.implement = "session-1"));
      yield* store.update((state) => void state.completed.push("spec"));
      yield* store.update((state) => void (state.prNumber = 7));
    }),
  );

  const written = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as RunState;
  assert.deepEqual(written.sessions, { implement: "session-1" }, "every change reaches the file, not just the first");
  assert.deepEqual(written.completed, ["spec"]);
  assert.equal(written.prNumber, 7);

  const resumed = await inDirectory(directory, (store) => Effect.succeed(store.get()));
  assert.deepEqual(resumed.completed, ["spec"]);
  assert.equal(resumed.sessions.implement, "session-1");
});

test("a state file from an older fabrika gains the fields it never had", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fabrika-store-"));
  await Effect.runPromise(
    Effect.promise(async () => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(directory, "state.json"), JSON.stringify({ branch: "feat/x", completed: ["spec"] }));
    }),
  );

  const state = await inDirectory(directory, (store) =>
    store.update((current) => void current.reran.push("run-1")).pipe(Effect.as(store.get())),
  );
  assert.equal(state.branch, "feat/x", "what the old file did say is kept");
  assert.deepEqual(state.reran, ["run-1"], "what it did not say does not blow up on first use");
  assert.equal(state.done, false);
});

test("two states built from the same empty template do not share their arrays", async () => {
  const first = mkdtempSync(join(tmpdir(), "fabrika-store-"));
  const second = mkdtempSync(join(tmpdir(), "fabrika-store-"));
  await inDirectory(first, (store) => store.update((state) => void state.completed.push("spec")));
  const other = await inDirectory(second, (store) => Effect.succeed(store.get()));
  assert.deepEqual(other.completed, []);
});

test("a service provided to several dependents is built once", async () => {
  // The whole design rests on this: the agent records a session in the same
  // RunState the driver reads `completed` from, because both got the one store.
  let built = 0;
  interface Counter {
    readonly id: number;
  }
  const Counter = Context.Service<Counter>("Counter");
  const counter = Layer.effect(Counter)(Effect.sync(() => ({ id: ++built })));

  interface Left {
    readonly id: number;
  }
  const Left = Context.Service<Left>("Left");
  interface Right {
    readonly id: number;
  }
  const Right = Context.Service<Right>("Right");

  // Wired exactly as run.ts wires the ports: one dependent on the foundation,
  // one on the foundation merged with the first, and the foundation itself
  // merged into the result.
  const left = Layer.effect(Left)(Effect.map(Counter, (c) => ({ id: c.id }))).pipe(Layer.provide(counter));
  const right = Layer.effect(Right)(Effect.map(Counter, (c) => ({ id: c.id }))).pipe(
    Layer.provide(Layer.merge(counter, left)),
  );

  const ids = await Effect.runPromise(
    Effect.gen(function* () {
      return [(yield* Counter).id, (yield* Left).id, (yield* Right).id];
    }).pipe(Effect.provide(Layer.mergeAll(counter, left, right))),
  );
  assert.equal(built, 1, "one instance");
  assert.deepEqual(ids, [1, 1, 1], "and everyone has it");
});
