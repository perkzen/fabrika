import { Effect } from "effect";
import assert from "node:assert/strict";
import { test } from "node:test";
import { sweep, type Placement, type SyncTarget } from "../src/pipeline/sweep.ts";
import type { PullRequestDetail } from "../src/ports/forge.ts";
import { exercise } from "./harness.ts";

/** A conflicted, on-base, fabrika-free pull request; every case overrides what it is about. */
const pullRequest = (over: Partial<PullRequestDetail> & { readonly number: number }): PullRequestDetail => ({
  url: `https://github.com/perkzen/fabrika/pull/${over.number}`,
  title: "fix: a thing",
  body: "a description",
  branch: `branch-${over.number}`,
  base: "main",
  state: "open",
  draft: true,
  fork: false,
  merge: "conflicted",
  ...over,
});

const placement = (target: SyncTarget): Placement => ({
  worktree: `/worktrees/pr-${target.number}`,
  log: `/runs/pr-${target.number}/log.txt`,
});

test("a sweep syncs the one conflicted pull request and counts it", async () => {
  const handed: Array<SyncTarget> = [];
  const { exit, failed, recording } = await exercise(
    sweep({
      base: "origin/main",
      concurrency: 2,
      dryRun: false,
      place: (target) => Effect.succeed(placement(target)),
      worker: (target) => Effect.sync(() => (handed.push(target), { pushed: "9f1c2ab3d4e5f6" })),
    }),
    { pullRequests: [pullRequest({ number: 42, title: "FAB-5: Conflicted PRs pile up" })] },
  );

  assert.equal(failed, false);
  assert.equal((exit as { exitCode: number }).exitCode, 0);
  assert.deepEqual(
    handed.map((target) => target.branch),
    ["branch-42"],
    "the conflicted pull request is the one handed to a worker",
  );
  assert.equal(recording.log[0], "sync: 1 open pull request(s) you authored on perkzen/fabrika");
  assert.ok(
    recording.log.includes("waiting for syncing 1 pull request(s)"),
    "the fan-out is a wait, so the live region animates through it",
  );
  assert.ok(
    recording.log.includes(
      "  #42 [yours] FAB-5: Conflicted PRs pile up — synced: pushed 9f1c2ab — log: /runs/pr-42/log.txt",
    ),
    `no synced line among ${JSON.stringify(recording.log)}`,
  );
  assert.equal(
    recording.log.at(-1),
    "sync: 1 synced, 0 already clean, 0 escalated, 0 failed, 0 skipped",
    "the counts are the last line, which is what a scheduled invocation reads",
  );
});
