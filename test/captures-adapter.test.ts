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
  options: {
    /** A real repository and a real sha make the base half an actual checkout. */
    readonly base?: { repoRoot: string; sha: string };
    /** What the fresh base checkout runs before the captures do. */
    readonly install?: string;
    /** `"missing"` leaves the run's own tree off the disk, as a crashed run would. */
    readonly worktree?: "missing";
  } = {},
) => {
  const { base = { repoRoot: "/repo", sha: BASE }, install } = options;
  const root = mkdtempSync(join(tmpdir(), "fabrika-captures-"));
  const cacheRoot = join(root, "cache");
  const cacheFor = (capture: string) => {
    const dir = join(cacheRoot, base.sha, capture);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  seed(cacheFor);

  const dir = join(root, "worktree");
  if (options.worktree !== "missing") mkdirSync(dir, { recursive: true });
  const world = harness({ dir, runs: join(root, "run"), repoRoot: base.repoRoot });

  const shots = await Effect.runPromise(
    Effect.flatMap(Captures, (port) => port.take(captures, base.sha)).pipe(
      Effect.provide(
        shellCaptures
          .layer({ cacheRoot, install })
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
  const { shots, log, cacheRoot } = await take([{ name: "console", run: writes({ "out.txt": "at the base" }) }], () => {}, { base });

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
  const { shots, log, cacheRoot } = await take([{ name: "console", run: "exit 1" }], () => {}, { base });

  assert.equal(shots[0]?.before, undefined);
  assert.equal(existsSync(join(cacheRoot, base.sha, "console")), false, "the staged half was never promoted");
  assert.ok(log.some((line) => line.includes("capture console: command failed (exit 1); no half")));
});

test("a capture command is not handed this machine's secrets", async () => {
  // The capture child inherits the operator's whole shell, which is where a
  // key named like one gets in — fabrika loads no `.env` of its own.
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

test("a base whose install failed is a missing half rather than a wrong one", async () => {
  const base = here();
  const { shots, log, cacheRoot } = await take(
    [{ name: "console", run: writes({ "out.txt": "at the base" }) }],
    () => {},
    { base, install: "exit 7" },
  );

  assert.equal(shots[0]?.before, undefined, "a tree whose dependencies are not there is not a base to capture");
  assert.equal(
    existsSync(join(cacheRoot, base.sha, "console")),
    false,
    "and a half captured against it is not cached for every later ticket on this base",
  );
  assert.ok(log.some((line) => line.includes("install failed (exit 7)")), "the operator is told which half went missing and why");
});

test("the budget the checkout and the install share is not also the capture's", async () => {
  const base = here();
  // 0.06 minutes is 3.6 seconds, and every part of this fits in it on its own:
  // the checkout plus a two-second install, and then a two-second command. Only
  // the sum does not, which is the thing that must not be measured.
  const { shots } = await take(
    [
      {
        name: "console",
        // Slow only in the base checkout, which is the tree with a package.json.
        run: `test -e package.json && sleep 2; ${writes({ "out.txt": "at the base" })}`,
        timeoutMinutes: 0.06,
      },
    ],
    () => {},
    { base, install: "sleep 2" },
  );

  assert.deepEqual(
    shots[0]?.before,
    [{ name: "out.txt", kind: "text", content: "at the base" }],
    "a capture may spend at the base the time its own timeout grants it",
  );
});

test("a capture that could not be started says so, rather than saying it ran out of time", async () => {
  // The run's own tree is gone, so `sh` never spawns. The two outcomes are a
  // minute apart in what they cost and in what an operator should do about
  // them, and both used to reach the journal as a timeout.
  const { shots, log } = await take([{ name: "console", run: "true" }], () => {}, { worktree: "missing" });

  assert.equal(shots[0]?.after, undefined);
  assert.ok(log.some((line) => line.includes("capture console: could not be started; no half")));
  assert.ok(!log.some((line) => line.includes("timed out")), "and nothing claims a deadline passed");
});

test("a file too big for the body is left out, and the journal says which", async () => {
  // 11 MB: over `ATTACHMENT_BYTES`, which is GitHub's own per-attachment
  // limit, so uploading it would fail the create rather than be dropped here.
  const { shots, log } = await take(
    [
      {
        name: "console",
        run: `head -c 11534336 /dev/zero > "$FABRIKA_CAPTURE_DIR/big.png" && ${writes({ "small.txt": "kept" })}`,
      },
    ],
    () => {},
  );

  assert.deepEqual(shots[0]?.after, [{ name: "small.txt", kind: "text", content: "kept" }], "the rest of the capture still shows");
  assert.ok(
    log.some((line) => line.includes("big.png") && line.includes("left out")),
    "a dropped file is explicable rather than an image that silently never appears",
  );
});
