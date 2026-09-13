import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const take = async (
  captures: ReadonlyArray<CaptureStep>,
  seed: (cache: (capture: string) => string) => void,
  /** A real repository and a real sha make the base half an actual checkout. */
  base: { repoRoot: string; sha: string } = { repoRoot: "/repo", sha: BASE },
) => {
  const root = mkdtempSync(join(tmpdir(), "fabrika-captures-"));
  const cacheRoot = join(root, "cache");
  const cacheFor = (capture: string) => {
    const dir = join(cacheRoot, base.sha, capture);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  seed(cacheFor);

  const dir = join(root, "worktree");
  mkdirSync(dir, { recursive: true });
  const world = harness({ dir, runs: join(root, "run"), repoRoot: base.repoRoot });

  const shots = await Effect.runPromise(
    Effect.flatMap(Captures, (port) => port.take(captures, base.sha)).pipe(
      Effect.provide(
        shellCaptures
          .layer({ cacheRoot, install: undefined })
          .pipe(Layer.provide(Layer.merge(world.layer, NodeServices.layer))),
      ),
    ),
  );
  return { shots, log: world.recording.log, dir, cacheRoot };
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

test("a branch command that fails is a missing half, not a failed run", async () => {
  const { shots, log } = await take([{ name: "console", run: "exit 3" }], (cache) => {
    writeFileSync(join(cache("console"), "out.txt"), "before");
  });

  assert.equal(shots.length, 1, "the run got its answer");
  assert.equal(shots[0]?.after, undefined, "and the half that did not happen is absent, not empty");
  assert.deepEqual(shots[0]?.before, [{ name: "out.txt", kind: "text", content: "before" }]);
  assert.ok(log.includes("capture console: command failed (exit 3); no half"), "with the exit code the operator needs");
  assert.ok(log.includes("capture console: no output; no section"), "and what it means for the pull request");
});

test("a base that will not check out still leaves the branch half to show", async () => {
  // Nothing is seeded, so the base is a miss and the adapter goes looking for
  // a worktree. The harness's `repoRoot` is not a repository, so it does not
  // get one — the case of a base commit the host cannot produce.
  const { shots, log } = await take([{ name: "console", run: writes({ "out.txt": "after" }) }], () => {});

  assert.deepEqual(shots, [
    { capture: "console", before: undefined, after: [{ name: "out.txt", kind: "text", content: "after" }] },
  ]);
  assert.ok(!log.some((line) => line.includes("(from cache)")), "nothing was cached");
});

test("a capture's files are what the body can carry, in pairing order", async () => {
  const { shots } = await take(
    [{ name: "console", run: writes({ "notes.md": "#", "b.txt": "second", "a.txt": "first", "link.url": "https://e.example" }) }],
    (cache) => {
      writeFileSync(join(cache("console"), "out.txt"), "before");
    },
  );

  assert.deepEqual(shots[0]?.after, [
    { name: "a.txt", kind: "text", content: "first" },
    { name: "b.txt", kind: "text", content: "second" },
    { name: "link.url", kind: "link", content: "https://e.example" },
  ], "sorted by name so the two halves pair deterministically, and `notes.md` is not a file the body carries");
});

/**
 * This repository, at its own HEAD: the only base a test can be sure checks
 * out. Read inside the test rather than at import, so the tests above — which
 * need no repository at all — still load and run where there is none.
 */
const here = () => ({ repoRoot: process.cwd(), sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() });

test("a base with no cached half is checked out, run, and kept for the next ticket", async () => {
  const base = here();
  const { shots, log, cacheRoot } = await take([{ name: "console", run: writes({ "out.txt": "at the base" }) }], () => {}, base);

  assert.deepEqual(shots[0]?.before, [{ name: "out.txt", kind: "text", content: "at the base" }], "the base half ran");
  assert.ok(log.some((line) => line.includes(`capture console: base ${base.sha.slice(0, 7)} captured in`)));
  assert.ok(!log.some((line) => line.includes("(from cache)")), "this ticket is the one that paid for it");
  assert.equal(
    readFileSync(join(cacheRoot, base.sha, "console", "out.txt"), "utf8"),
    "at the base",
    "and the next ticket cut from this base will find it already there",
  );
});

test("a base command that fails leaves nothing in the cache to become a permanent hit", async () => {
  const base = here();
  const { shots, log, cacheRoot } = await take([{ name: "console", run: "exit 1" }], () => {}, base);

  assert.equal(shots[0]?.before, undefined);
  assert.equal(existsSync(join(cacheRoot, base.sha, "console")), false, "the staged half was never promoted");
  assert.ok(log.some((line) => line.includes("capture console: command failed (exit 1); no half")));
});

test("a capture command is not handed this machine's secrets", async () => {
  // `fabrika run` loads `~/.config/fabrika/.env` into its own environment for
  // its own Linear and Claude calls, and the capture child inherits it.
  process.env.LINEAR_API_KEY = "lin_api_secret";
  process.env.SOME_SERVICE_TOKEN = "tok_secret";
  process.env.HOME_BREW_PREFIX = "/opt/homebrew";
  try {
    const { shots } = await take(
      // Named one by one rather than dumped: `textContent` caps the file at
      // twenty lines, so a bare `env` would pass on the cap alone.
      [{ name: "console", run: 'printf %s "[$LINEAR_API_KEY][$SOME_SERVICE_TOKEN][$HOME_BREW_PREFIX]" > "$FABRIKA_CAPTURE_DIR/out.txt"' }],
      () => {},
    );

    const environment = shots[0]?.after?.[0]?.content ?? "";
    assert.ok(!environment.includes("lin_api_secret"), "the key fabrika itself needs is not the capture's to print");
    assert.ok(!environment.includes("tok_secret"));
    assert.ok(environment.includes("/opt/homebrew"), "and a variable a capture needs to find its tools survives");
  } finally {
    delete process.env.LINEAR_API_KEY;
    delete process.env.SOME_SERVICE_TOKEN;
    delete process.env.HOME_BREW_PREFIX;
  }
});
