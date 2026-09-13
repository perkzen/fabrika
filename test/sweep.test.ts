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

/**
 * One pull request per rule, in the order the rules fire. `#49` is merged
 * *and* unknown — GitHub reports `mergeable: UNKNOWN` on a merged pull request
 * forever — so its line is what proves first match wins.
 */
const everyRule: ReadonlyArray<PullRequestDetail> = [
  pullRequest({ number: 50, title: "chore: abandoned", state: "closed" }),
  pullRequest({
    number: 49,
    title: "FAB-2: No review bot",
    body: "---\nOpened by fabrika. Draft until a human reviews.",
    state: "merged",
    merge: "unknown",
  }),
  pullRequest({ number: 48, title: "feat: from a fork", fork: true }),
  pullRequest({ number: 47, title: "feat: stacked thing", base: "develop" }),
  pullRequest({ number: 46, title: "chore: bump deps", merge: "unknown" }),
  pullRequest({ number: 45, title: "fix: merely behind", merge: "behind" }),
  pullRequest({ number: 44, title: "fix: perfectly clean", merge: "clean" }),
  pullRequest({ number: 43, title: "fix: being worked on" }),
  pullRequest({ number: 42, title: "FAB-5: Conflicted PRs pile up" }),
];

test("every skipped pull request names the rule that skipped it", async () => {
  const { recording } = await exercise(
    sweep({
      base: "origin/main",
      concurrency: 2,
      dryRun: false,
      place: (target) => Effect.succeed(placement(target)),
      worker: () => Effect.succeed({ pushed: "9f1c2ab3d4e5f6" }),
    }),
    { pullRequests: everyRule, checkedOut: [{ branch: "branch-43", path: "/Users/x/dev/fabrika" }] },
  );

  assert.deepEqual(recording.log.slice(0, 10), [
    "sync: 9 open pull request(s) you authored on perkzen/fabrika",
    "  #50 [yours] chore: abandoned — skipped: closed",
    "  #49 [fabrika] FAB-2: No review bot — skipped: already merged",
    "  #48 [yours] feat: from a fork — skipped: opened from a fork; nothing here can push to it",
    "  #47 [yours] feat: stacked thing — skipped: targets develop, not main",
    "  #46 [yours] chore: bump deps — skipped: merge state unknown — GitHub would not compute it",
    "  #45 [yours] fix: merely behind — skipped: not conflicted (behind)",
    "  #44 [yours] fix: perfectly clean — skipped: not conflicted (clean)",
    "  #43 [yours] fix: being worked on — skipped: branch is checked out at /Users/x/dev/fabrika",
    "sync: 1 conflicted, 8 skipped",
  ]);
  assert.equal(recording.log.at(-1), "sync: 1 synced, 0 already clean, 0 escalated, 0 failed, 8 skipped");
});
