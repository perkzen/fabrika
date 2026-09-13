import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import * as shellCaptures from "../src/adapters/shell-captures.ts";
import type { CaptureStep } from "../src/config.ts";
import { Captures } from "../src/ports/captures.ts";
import { harness } from "./harness.ts";

const BASE = "a1b2c3d4e5f6";

/**
 * The adapter over a real filesystem and real subprocesses, as `gate.test.ts`
 * runs `shell-gate`.
 *
 * The base half is seeded straight into the cache, so every test here is a
 * cache hit and none of them checks a `git worktree` out: what is under test
 * is what the adapter decides, not what git does.
 */
const take = async (captures: ReadonlyArray<CaptureStep>, seed: (cache: (capture: string) => string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "fabrika-captures-"));
  const cacheRoot = join(root, "cache");
  const cacheFor = (capture: string) => {
    const dir = join(cacheRoot, BASE, capture);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  seed(cacheFor);

  const dir = join(root, "worktree");
  mkdirSync(dir, { recursive: true });
  const world = harness({ dir, runs: join(root, "run") });

  const shots = await Effect.runPromise(
    Effect.flatMap(Captures, (port) => port.take(captures, BASE)).pipe(
      Effect.provide(
        shellCaptures
          .layer({ cacheRoot, install: undefined })
          .pipe(Layer.provide(Layer.merge(world.layer, NodeServices.layer))),
      ),
    ),
  );
  return { shots, log: world.recording.log, dir };
};

/** `printf` over `echo -n`: portable across the `sh` a host happens to have. */
const writes = (files: Record<string, string>) =>
  Object.entries(files)
    .map(([name, content]) => `printf %s ${JSON.stringify(content)} > "$FABRIKA_CAPTURE_DIR/${name}"`)
    .join(" && ");

test("a cached base half and a branch that writes are the shot's two halves", async () => {
  const { shots, log } = await take([{ name: "console", run: writes({ "out.txt": "after" }) }], (cache) => {
    writeFileSync(join(cache("console"), "out.txt"), "before");
  });

  assert.deepEqual(shots, [
    {
      capture: "console",
      before: [{ name: "out.txt", kind: "text", content: "before" }],
      after: [{ name: "out.txt", kind: "text", content: "after" }],
    },
  ]);
  assert.ok(log.includes("capture console: base a1b2c3d (from cache)"), "the operator is told the base cost nothing");
});
