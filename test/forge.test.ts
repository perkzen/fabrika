import assert from "node:assert/strict";
import { test } from "node:test";
import { Duration, Effect } from "effect";
import { settle } from "../src/adapters/gh-forge.ts";
import type { MergeState, PullRequestDetail } from "../src/ports/forge.ts";
import { Journal } from "../src/ports/journal.ts";
import { harness } from "./harness.ts";

/**
 * GitHub computes a pull request's mergeability lazily, and the listing is
 * what starts it — so `gh pr list` answers `UNKNOWN` for pull requests it has
 * not got to yet, and the fix is to ask again. These are the rules of asking
 * again; the only thing stubbed is the `gh` call itself.
 */
const pr = (number: number, merge: MergeState): PullRequestDetail => ({
  number,
  url: `https://github.com/perkzen/fabrika/pull/${number}`,
  title: "fix: a thing",
  body: "a description",
  branch: `branch-${number}`,
  base: "main",
  state: "open",
  draft: true,
  fork: false,
  merge,
});

/** One `gh pr list`, scripted: each call answers the next listing, the last repeats. */
const listings = (...answers: ReadonlyArray<ReadonlyArray<PullRequestDetail>>) => {
  let at = 0;
  return {
    listed: Effect.sync(() => (at += 1, answers[Math.min(at - 1, answers.length - 1)]!)),
    calls: () => at,
  };
};

/** The harness's in-memory `Journal`, which is the agreed stand-in for the real one. */
const journalOf = (world: ReturnType<typeof harness>) =>
  Effect.runSync(Effect.provide(Effect.gen(function* () {
    return yield* Journal;
  }), world.layer));

/** No gap between attempts: what a test may not do is wait out a real one. */
const settled = (world: ReturnType<typeof harness>, listed: Effect.Effect<ReadonlyArray<PullRequestDetail>>) =>
  Effect.runPromise(settle(listed, journalOf(world), Duration.zero));

const states = (prs: ReadonlyArray<PullRequestDetail>) => prs.map((pr) => [pr.number, pr.merge]);

test("a listing that came back settled is the answer, with no second call and no wait", async () => {
  const world = harness();
  const { listed, calls } = listings([pr(42, "conflicted"), pr(41, "clean")]);

  assert.deepEqual(states(await settled(world, listed)), [
    [42, "conflicted"],
    [41, "clean"],
  ]);
  assert.equal(calls(), 1, "GitHub had computed every merge state, so there is nothing to ask twice");
  assert.deepEqual(world.recording.log, [], "and no wait is announced for one that never happens");
});

test("a merge state GitHub had not computed yet is asked for again", async () => {
  const world = harness();
  const { listed, calls } = listings([pr(42, "unknown"), pr(41, "clean")], [pr(42, "conflicted"), pr(41, "clean")]);

  assert.deepEqual(states(await settled(world, listed)), [
    [42, "conflicted"],
    [41, "clean"],
  ]);
  assert.equal(calls(), 2, "one more listing, not one call per pending pull request");
  assert.ok(
    world.recording.log.includes("waiting for merge state of 1 pull request(s)"),
    `the wait names how many were pending, not how many there are: ${JSON.stringify(world.recording.log)}`,
  );
});

test("an answer already held survives a listing that loses it, and a new pull request is picked up", async () => {
  const world = harness();
  const { listed, calls } = listings(
    [pr(42, "unknown"), pr(41, "unknown")],
    [pr(42, "conflicted"), pr(41, "unknown"), pr(40, "clean")],
    [pr(42, "unknown"), pr(41, "behind"), pr(40, "clean")],
  );

  assert.deepEqual(
    states(await settled(world, listed)),
    [
      [42, "conflicted"],
      [41, "behind"],
      [40, "clean"],
    ],
    "#42 flaked back to unknown on the last listing; a sweep that forgot it would skip the one conflicted pull request",
  );
  assert.equal(calls(), 3);
});

test("a merge state GitHub never computes is answered as unknown, not waited on forever", async () => {
  const world = harness();
  const { listed, calls } = listings([pr(42, "unknown")]);

  assert.deepEqual(
    states(await settled(world, listed)),
    [[42, "unknown"]],
    "which the selection rule then reports as its own skip reason, rather than guessing either way",
  );
  assert.equal(calls(), 3, "the first listing and both refreshes, then it gives up");
});
