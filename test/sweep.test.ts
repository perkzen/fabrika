import { Effect } from "effect";
import assert from "node:assert/strict";
import { test } from "node:test";
import { FabrikaError } from "../src/errors.ts";
import { Escalated } from "../src/pipeline/escalated.ts";
import { sweep, type Placement, type SweepOptions, type SyncTarget } from "../src/pipeline/sweep.ts";
import { AgentRateLimited } from "../src/ports/agent.ts";
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

test("a dry run reports the selection and calls no worker", async () => {
  let called = 0;
  const { exit, recording } = await exercise(
    sweep({
      base: "origin/main",
      concurrency: 2,
      dryRun: true,
      place: (target) => Effect.sync(() => (called += 1, placement(target))),
      worker: () => Effect.sync(() => (called += 1, { pushed: "9f1c2ab3d4e5f6" })),
    }),
    { pullRequests: everyRule },
  );

  assert.equal((exit as { exitCode: number }).exitCode, 0);
  assert.equal(called, 0, "the dry run's promise is that it touches nothing, the run directory scan included");
  assert.deepEqual(recording.log.slice(-4), [
    "sync: 2 conflicted, 7 skipped",
    "  #43 [yours] fix: being worked on — would sync branch-43 into origin/main",
    "  #42 [yours] FAB-5: Conflicted PRs pile up — would sync branch-42 into origin/main",
    "dry run: 2 would be synced, 7 skipped; nothing changed",
  ]);
});

const twoConflicted: ReadonlyArray<PullRequestDetail> = [
  pullRequest({ number: 42, title: "FAB-5: Conflicted PRs pile up" }),
  pullRequest({ number: 40, title: "fix: thing" }),
];

/** Concurrency 1 so the order the lines land in is the sweep's, not the scheduler's. */
const oneAtATime = (worker: SweepOptions["worker"]): SweepOptions => ({
  base: "origin/main",
  concurrency: 1,
  dryRun: false,
  place: (target) => Effect.succeed(placement(target)),
  worker,
});

test("one worker's escalation leaves the others alone and sets the exit code", async () => {
  const { exit, failed, recording } = await exercise(
    sweep(
      oneAtATime((target, where) =>
        target.number === 40
          ? Effect.fail(
              new Escalated({
                reason: "merge left conflicts in src/a.ts",
                worktree: where.worktree,
                prUrl: target.url,
              }),
            )
          : Effect.succeed({ pushed: "9f1c2ab3d4e5f6" }),
      ),
    ),
    { pullRequests: twoConflicted },
  );

  assert.equal(failed, false, "a worker's failure is a value; the fan-out is not taken down by it");
  assert.equal((exit as { exitCode: number }).exitCode, 2);
  assert.deepEqual(recording.log.slice(-4), [
    "  #42 [yours] FAB-5: Conflicted PRs pile up — synced: pushed 9f1c2ab — log: /runs/pr-42/log.txt",
    "  #40 [yours] fix: thing — escalated: merge left conflicts in src/a.ts — worktree: /worktrees/pr-40 — log: /runs/pr-40/log.txt",
    "waited 0s for syncing 2 pull request(s)",
    "sync: 1 synced, 0 already clean, 1 escalated, 0 failed, 0 skipped",
  ]);
});

test("a worker that failed outside an escalation reads as failed", async () => {
  const { exit, recording } = await exercise(
    sweep(
      oneAtATime((target) =>
        target.number === 40
          ? Effect.fail(new FabrikaError({ message: "git fetch origin: boom" }))
          : Effect.succeed({ pushed: "9f1c2ab3d4e5f6" }),
      ),
    ),
    { pullRequests: twoConflicted },
  );

  assert.equal((exit as { exitCode: number }).exitCode, 2);
  assert.deepEqual(recording.log.slice(-3), [
    "  #40 [yours] fix: thing — failed: git fetch origin: boom — log: /runs/pr-40/log.txt",
    "waited 0s for syncing 2 pull request(s)",
    "sync: 1 synced, 0 already clean, 0 escalated, 1 failed, 0 skipped",
  ]);
});

test("the usage limit stops the sweep handing out new work", async () => {
  const placed: Array<number> = [];
  const { exit, recording } = await exercise(
    sweep({
      base: "origin/main",
      concurrency: 1,
      dryRun: false,
      place: (target) => Effect.sync(() => (placed.push(target.number), placement(target))),
      worker: (target) =>
        target.number === 42
          ? Effect.fail(new AgentRateLimited({ credential: "default", sessionId: null }))
          : Effect.succeed({ pushed: "9f1c2ab3d4e5f6" }),
    }),
    {
      pullRequests: [
        pullRequest({ number: 42, title: "FAB-5: Conflicted PRs pile up" }),
        pullRequest({ number: 41, title: "fix: second" }),
        pullRequest({ number: 40, title: "fix: thing" }),
      ],
    },
  );

  assert.equal((exit as { exitCode: number }).exitCode, 3, "3 beats the 2 the failed worker would have set");
  assert.deepEqual(placed, [42], "a pull request that never started gets no worktree and no run directory");
  assert.deepEqual(recording.log.slice(-5), [
    "  #42 [yours] FAB-5: Conflicted PRs pile up — failed: usage limit hit — worktree: /worktrees/pr-42 — log: /runs/pr-42/log.txt",
    "  #41 [yours] fix: second — skipped: usage limit hit — not started",
    "  #40 [yours] fix: thing — skipped: usage limit hit — not started",
    "waited 0s for syncing 3 pull request(s)",
    "sync: 0 synced, 0 already clean, 0 escalated, 1 failed, 2 skipped",
  ]);
});
