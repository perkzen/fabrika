import assert from "node:assert/strict";
import { test } from "node:test";
import { pipeline } from "../src/pipeline/step.ts";
import { reviewRounds } from "../src/pipeline/steps/review.ts";
import type { Check } from "../src/ports/forge.ts";
import type { Review } from "../src/ports/reviewer.ts";
import { exercise } from "./harness.ts";

const clean: Review = { commit: "sha1", score: 5, threads: [] };
const thread = { id: "t1", path: "src/a.ts", line: 4, body: "this is wrong" };
const failingCheck: Check = {
  name: "CI / test",
  url: "https://github.com/perkzen/fabrika/actions/runs/1/job/2",
  state: "fail",
  job: { repo: "perkzen/fabrika", id: "1", jobId: "2" },
};
const open = { state: { prNumber: 7, branch: "feat/x", pushed: ["sha1"] } };

/** The done: line is the driver's, so the tests that assert it run the step through one. */
const driven = pipeline().step(reviewRounds).build().run;

test("a clean round finishes the run and takes the worktree with it", async () => {
  const { failed, recording } = await exercise(driven, { ...open, reviews: [clean], checks: [[]] });
  assert.equal(failed, false);
  assert.equal(recording.state().done, true);
  assert.deepEqual(recording.removed, ["/worktree"]);
  assert.ok(recording.log.some((line) => line.startsWith("done:")));
});

test("a run that cannot keep its artifacts is not recorded as done, so a resume finishes it", async () => {
  const first = await exercise(driven, { ...open, reviews: [clean], checks: [[]], archiveFails: true });
  assert.equal(first.failed, true);
  assert.equal(first.recording.state().done, false, "the state a resume reads still has work in it");
  assert.deepEqual(first.recording.removed, [], "and the worktree the artifacts are still in survives");
  assert.ok(!first.recording.log.some((line) => line.startsWith("done:")), "nothing claimed a finished run");

  // The resume the first half bought: the same clean verdict, now archived.
  const { failed, recording } = await exercise(driven, {
    ...open,
    state: first.recording.state(),
    reviews: [clean],
    checks: [[]],
  });
  assert.equal(failed, false);
  assert.equal(recording.state().round, 2, "a retry of the finishing, not a restart of the run");
  assert.equal(recording.state().done, true);
  assert.deepEqual(recording.removed, ["/worktree"]);
  assert.ok(recording.log.some((line) => line.startsWith("done:")));
});

test("a score below the bar with nothing to act on escalates instead of waiting for the same verdict", async () => {
  const { exit, failed } = await exercise(reviewRounds.run, {
    ...open,
    reviews: [{ commit: "sha1", score: 3, threads: [] }],
    checks: [[]],
  });
  assert.equal(failed, true);
  assert.match((exit as { reason: string }).reason, /score 3\/5 with no open threads or failing checks/);
});

test("a review that never arrives escalates with the PR to look at", async () => {
  const { exit, failed } = await exercise(reviewRounds.run, { ...open, reviews: [undefined] });
  assert.equal(failed, true);
  assert.match((exit as { reason: string }).reason, /no fake review within/);
  assert.equal((exit as { prUrl: string }).prUrl, "https://github.com/perkzen/fabrika/pull/7");
});

test("a thread the agent fixed is replied to and resolved when a commit touched that file", async () => {
  const { recording } = await exercise(reviewRounds.run, {
    ...open,
    config: { review: { provider: "cubic", requireScore: 5, maxRounds: 1, timeoutMinutes: 1 } },
    reviews: [{ commit: "sha1", score: 4, threads: [thread] }],
    checks: [[]],
    touched: ["src/a.ts"],
    agent: () => ({ text: "", structured: { decisions: [{ threadId: "t1", action: "fixed", reply: "fixed it" }] } }),
  });
  assert.deepEqual(recording.replied, [{ thread: "t1", body: "fixed it" }]);
  assert.deepEqual(recording.resolved, ["t1"]);
});

test("a claimed fix with no commit touching that file is replied to but left open", async () => {
  const { recording } = await exercise(reviewRounds.run, {
    ...open,
    config: { review: { provider: "cubic", requireScore: 5, maxRounds: 1, timeoutMinutes: 1 } },
    reviews: [{ commit: "sha1", score: 4, threads: [thread] }],
    checks: [[]],
    touched: [],
    agent: () => ({ text: "", structured: { decisions: [{ threadId: "t1", action: "fixed", reply: "fixed it" }] } }),
  });
  assert.deepEqual(recording.replied, [{ thread: "t1", body: "fixed it" }]);
  assert.deepEqual(recording.resolved, [], "the human sees the thread that nothing was done about");
  assert.ok(recording.log.some((line) => line.includes("left open: no commit touched it")));
});

test("a decision about a thread that was never open is ignored", async () => {
  const { recording } = await exercise(reviewRounds.run, {
    ...open,
    config: { review: { provider: "cubic", requireScore: 5, maxRounds: 1, timeoutMinutes: 1 } },
    reviews: [{ commit: "sha1", score: 4, threads: [thread] }],
    checks: [[]],
    touched: ["src/a.ts"],
    agent: () => ({ text: "", structured: { decisions: [{ threadId: "invented", action: "fixed", reply: "hi" }] } }),
  });
  assert.deepEqual(recording.replied, []);
});

test("a failing check is rerun once for a flake, then handed to the agent with its log", async () => {
  const { recording } = await exercise(reviewRounds.run, {
    ...open,
    config: { review: { provider: "cubic", requireScore: 5, maxRounds: 1, timeoutMinutes: 1 } },
    reviews: [{ commit: "sha1", score: 5, threads: [] }],
    checks: [[failingCheck], [failingCheck]],
  });
  assert.deepEqual(recording.rerun, ["1"], "rerun once");
  assert.deepEqual(recording.state().reran, ["1"], "and recorded, so the next round does not rerun it again");
  const ci = recording.agent.find((call) => call.stage === "ci");
  assert.ok(ci && ci.prompt.includes("the failing log"));
});

test("checks that never settle escalate rather than passing an unknown state off as green", async () => {
  const { exit, failed } = await exercise(reviewRounds.run, {
    ...open,
    reviews: [clean],
    checks: [undefined],
  });
  assert.equal(failed, true);
  assert.match((exit as { reason: string }).reason, /checks still pending/);
});

test("green CI with no reviewer finishes the run rather than escalating on a review nobody sought", async () => {
  const { failed, recording } = await exercise(driven, { ...open, reviewer: "none", checks: [[]] });
  assert.equal(failed, false);
  assert.equal(recording.state().done, true);
  assert.deepEqual(recording.removed, ["/worktree"]);
  assert.equal(
    recording.log.at(-1),
    "done: no review bot, checks green — ready for human review: https://github.com/perkzen/fabrika/pull/7",
  );
});

test("a failing check with no reviewer is rerun once, handed to the agent, and the next green round finishes the run", async () => {
  const { failed, recording } = await exercise(reviewRounds.run, {
    ...open,
    reviewer: "none",
    checks: [[failingCheck], [failingCheck], []],
  });
  assert.deepEqual(recording.rerun, ["1"], "rerun once for a flake, the same as with a bot");
  const ci = recording.agent.find((call) => call.stage === "ci");
  assert.ok(ci && ci.prompt.includes("the failing log"));
  assert.ok(
    recording.log.includes("  no reviewer, 1 failing check(s)"),
    "the round line names its own subject and claims no score",
  );
  assert.equal(failed, false);
  assert.equal(recording.state().done, true);
});

test("a check that stays red with no reviewer escalates after maxRounds, with the PR to look at", async () => {
  const { exit, failed } = await exercise(reviewRounds.run, { ...open, reviewer: "none", checks: [[failingCheck]] });
  assert.equal(failed, true);
  assert.match((exit as { reason: string }).reason, /not clean after 3 review rounds/);
  assert.equal((exit as { prUrl: string }).prUrl, "https://github.com/perkzen/fabrika/pull/7");
});

test("checks that never settle with no reviewer escalate rather than being passed off as green", async () => {
  const { exit, failed } = await exercise(reviewRounds.run, { ...open, reviewer: "none", checks: [undefined] });
  assert.equal(failed, true);
  assert.match((exit as { reason: string }).reason, /checks still pending/);
});
