import assert from "node:assert/strict";
import { test } from "node:test";
import { bound, outline, take, waiting } from "../src/domain/outline.ts";
import type { RunEvent } from "../src/domain/run-event.ts";

/** Local noon on a fixed day, so a stamped entry reads the way the console's does. */
const noon = new Date(2026, 0, 1, 12, 0, 0).getTime();

/** A scripted run: seconds from noon, and the event that arrived then. */
const script = (...events: ReadonlyArray<readonly [number, RunEvent | string]>) =>
  outline(events.map(([seconds, entry]) => ({ when: noon + seconds * 1000, entry })));

const RUN: RunEvent = {
  kind: "run",
  completed: ["spec"],
  steps: [{ name: "spec", done: true }, { name: "implement", done: false }, { name: "review", done: false }],
};

test("a run event becomes a root with one pending node per step", () => {
  const tree = script([0, RUN]);

  assert.equal(tree.roots.length, 1, "one run, one root");
  assert.deepEqual(
    tree.roots[0]!.children.map((node) => [node.at, node.of, node.name, node.state]),
    [
      [1, 3, "spec", "already-done"],
      [2, 3, "implement", "pending"],
      [3, 3, "review", "pending"],
    ],
    "the step list the run announces, with the resumed step already behind it",
  );
  assert.equal(
    new Set(tree.roots[0]!.children.map((node) => node.key)).size,
    3,
    "keys are unique, so a pipeline with two steps of one name is still two rows",
  );
});

test("a finished step's summary is the arithmetic of the events inside it", () => {
  const tree = script(
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [2, { kind: "tool", stage: "implement", tool: "Bash", subject: "pnpm test" }],
    [3, { kind: "tool", stage: "implement", tool: "Read", subject: "src/cli.ts" }],
    [4, { kind: "cost", stage: "implement", usd: 0.25 }],
    [5, { kind: "tool", stage: "implement", tool: "Bash", subject: "git commit" }],
    [6, { kind: "tool", stage: "implement", tool: "Edit", subject: "src/cli.ts" }],
    [7, { kind: "gate", name: "compile", at: 1, of: 2, command: "tsc", state: "pass", seconds: 3 }],
    [8, { kind: "gate", name: "test", at: 2, of: 2, command: "pnpm test", state: "fail", seconds: 41, exitCode: 1 }],
    [9, { kind: "cost", stage: "implement", usd: 0.5 }],
    [533, { kind: "step", name: "implement", at: 2, of: 3, state: "end", seconds: 533, outcome: "done" }],
  );

  const step = tree.roots[0]!.children[1]!;
  assert.equal(step.state, "done");
  assert.deepEqual(step.summary, {
    seconds: 533,
    usd: 0.75,
    calls: 4,
    // Descending by count and then by name, so Edit and Read cannot swap places
    // between two runs of the same events.
    tools: [{ tool: "Bash", count: 2 }, { tool: "Edit", count: 1 }, { tool: "Read", count: 1 }],
    skills: [],
    gates: [
      { name: "compile", state: "pass", seconds: 3 },
      { name: "test", state: "fail", seconds: 41 },
    ],
  });
});

test("events are attributed to the open step, never to their stage field", () => {
  const tree = script(
    [0, RUN],
    [1, "the branch is perkzen/feat/FAB-6"],
    [2, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    // `stage` is the agent's label for one call — the review loop makes calls
    // under `ci` and `cubic-gate` — so it says nothing about which step is open.
    [3, { kind: "tool", stage: "ci", tool: "Bash", subject: "pnpm test" }],
    [4, { kind: "step", name: "implement", at: 2, of: 3, state: "end", seconds: 9, outcome: "done" }],
    [5, { kind: "note", level: "info", text: "PR https://github.com/perkzen/fabrika/pull/7" }],
  );

  const [root] = tree.roots;
  assert.deepEqual(
    root!.children.map((step) => step.stream.length),
    [0, 1, 0],
    "the tool call is the open step's, whatever it calls its stage",
  );
  assert.deepEqual(
    root!.stream.map(({ entry }) => (typeof entry === "string" ? entry : entry.kind)),
    ["the branch is perkzen/feat/FAB-6", "note"],
    "before the first start and after the last end there is no open step, so the events are the run's",
  );
  assert.equal(root!.children[1]!.summary.calls, 1);
});

test("a Skill tool call names an invoked skill, and the same skill twice is one", () => {
  const tree = script(
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [2, { kind: "tool", stage: "implement", tool: "Skill", subject: "fabrika:tdd" }],
    [3, { kind: "tool", stage: "implement", tool: "Bash", subject: "pnpm test" }],
    [4, { kind: "tool", stage: "implement", tool: "Skill", subject: "fabrika:code-comments" }],
    [5, { kind: "tool", stage: "implement", tool: "Skill", subject: "fabrika:tdd" }],
    // An unknown tool has no subject to name, and a nameless skill is no skill.
    [6, { kind: "tool", stage: "implement", tool: "Skill", subject: "" }],
  );

  const step = tree.roots[0]!.children[1]!;
  assert.deepEqual(step.summary.skills, ["fabrika:tdd", "fabrika:code-comments"], "first-use order, deduplicated");
  assert.equal(step.summary.calls, 5, "an invoked skill is still a tool call");
});

test("a skipped step carries its reason instead of a summary", () => {
  const tree = script(
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "skipped", reason: "fix ticket; runs for feat" }],
  );

  const step = tree.roots[0]!.children[1]!;
  assert.equal(step.state, "skipped");
  assert.equal(step.summary.reason, "fix ticket; runs for feat");
  assert.equal(step.summary.calls, 0, "nothing ran, so there is nothing to roll up");
  assert.equal(step.summary.seconds, undefined, "and no duration: its one line is its end");
});

test("a second run event appends a second root", () => {
  const tree = script(
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [2, { kind: "run", completed: [], steps: [{ name: "preflight", done: false }, { name: "review", done: false }] }],
    [3, { kind: "step", name: "review", at: 2, of: 2, state: "start" }],
  );

  assert.deepEqual(
    tree.roots.map((root) => root.children.map((step) => `${step.name}:${step.state}`)),
    [
      ["spec:already-done", "implement:running", "review:pending"],
      ["preflight:pending", "review:running"],
    ],
    "a sweep over many pull requests is this tree with more roots; nothing here emits a second one yet",
  );
  assert.equal(new Set(tree.roots.flatMap((root) => root.children.map((step) => step.key))).size, 5, "keys stay unique across roots");
});

test("a node is called by the run event's title, or by its name when the run gave none", () => {
  const tree = script([
    0,
    {
      kind: "run",
      completed: [],
      steps: [{ name: "implement", title: "Implement", about: "agent · gate", done: false }, { name: "review", done: false }],
    },
  ]);
  const [implement, review] = tree.roots[0]!.children;

  assert.equal(implement!.title, "Implement");
  assert.equal(implement!.about, "agent · gate");
  assert.equal(implement!.name, "implement", "the name is untouched: it is what the completed list and every plain line say");
  assert.equal(review!.title, "review", "a step the run did not title is called by its name");
  assert.equal(review!.about, undefined);
});

test("a step knows when it started, and the root when the run did, so a live row can say how long", () => {
  const tree = script([0, RUN], [7, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }]);
  const root = tree.roots[0]!;

  assert.equal(root.since, noon, "the run's own clock starts at its event");
  assert.equal(root.children[1]!.since, noon + 7000, "and a step's at its start");
  assert.equal(root.children[2]!.since, undefined, "a step that has not started has no since to count from");
});

/**
 * A sweep's shape: several steps open at once, which a run never has. What
 * decides where an event goes is then the address the presenter put on it, not
 * "the one child whose state is `running`".
 */
const addressed = (...events: ReadonlyArray<readonly [number, RunEvent | string, string?]>) =>
  outline(events.map(([seconds, entry, address]) => ({ when: noon + seconds * 1000, entry, address })));

const SWEEP: RunEvent = {
  kind: "run",
  completed: [],
  steps: [{ name: "FAB-5-42", done: false }, { name: "pr-41", done: false }, { name: "FAB-9-40", done: false }],
};

const swept = (...extra: ReadonlyArray<readonly [number, RunEvent | string, string?]>) =>
  addressed(
    [0, SWEEP],
    [1, { kind: "step", name: "FAB-5-42", at: 1, of: 3, state: "start" }],
    [1, { kind: "step", name: "pr-41", at: 2, of: 3, state: "start" }],
    [1, { kind: "step", name: "FAB-9-40", at: 3, of: 3, state: "start" }],
    ...extra,
  );

test("an addressed event lands in the row it names, whatever else is running", () => {
  const tree = swept(
    [2, "worktree /worktrees/pr-41", "pr-41"],
    [3, "worktree /worktrees/FAB-5-42", "FAB-5-42"],
    [4, { kind: "tool", stage: "sync", tool: "Edit", subject: "src/b.ts" }, "pr-41"],
  );
  const rows = tree.roots[0]!.children;

  assert.deepEqual(rows.map((row) => row.stream.map(({ entry }) => (typeof entry === "string" ? entry : entry.kind))), [
    ["worktree /worktrees/FAB-5-42"],
    ["worktree /worktrees/pr-41", "tool"],
    [],
  ]);
  assert.equal(rows[1]!.summary.calls, 1, "and the summary it folds into is that row's too");
});

test("with more than one row open, an unaddressed event belongs to none of them", () => {
  const tree = swept([2, "sync: 2 conflicted, 1 skipped"]);

  assert.deepEqual(tree.roots[0]!.children.map((row) => row.stream.length), [0, 0, 0]);
  assert.equal(tree.roots[0]!.stream.length, 1, "the sweep's own line is the sweep's, not the first worker's");
});

test("each row's waits are its own, so one ending leaves the others open", () => {
  const wait = (state: "start" | "end") => ({ kind: "wait" as const, state, subject: "the merge agent" });
  const tree = swept([2, wait("start"), "FAB-5-42"], [3, wait("start"), "pr-41"], [4, wait("end"), "pr-41"]);
  const rows = tree.roots[0]!.children;

  assert.deepEqual(rows.map((row) => row.waits.map((open) => open.subject)), [["the merge agent"], [], []]);
  assert.equal(rows[0]!.waits[0]!.since, noon + 2000, "and it is still timed from where it opened");
});

test("a wait that opened before any row started is the sweep's, and its end finds it there", () => {
  const subject = "syncing 2 pull request(s)";
  const opened = addressed([0, SWEEP], [1, { kind: "wait", state: "start", subject }]);
  assert.deepEqual(opened.roots[0]!.waits.map((wait) => wait.subject), [subject], "no row was running, so it is the root's");

  const closed = addressed(
    [0, SWEEP],
    [1, { kind: "wait", state: "start", subject }],
    [2, { kind: "step", name: "FAB-5-42", at: 1, of: 3, state: "start" }],
    [3, { kind: "step", name: "FAB-5-42", at: 1, of: 3, state: "end", seconds: 1, outcome: "done" }],
    [4, { kind: "wait", state: "end", subject, seconds: 3 }],
  );
  assert.deepEqual(closed.roots[0]!.waits, [], "and the end clears it wherever it was opened");
});

test("a row's worktree is told to the tree rather than carried by an event", () => {
  const tree = bound(swept(), "pr-41", "/worktrees/pr-41");

  assert.deepEqual(tree.roots[0]!.children.map((row) => row.worktree), [undefined, "/worktrees/pr-41", undefined]);
  assert.deepEqual(
    bound(tree, "no-such-row", "/worktrees/nowhere").roots[0]!.children.map((row) => row.worktree),
    [undefined, "/worktrees/pr-41", undefined],
    "a name that names no row places no tree",
  );
  assert.equal(waiting(tree), false, "and nothing here is a wait");
});

/**
 * The case a "one open step" rule gets wrong: a sweep of two at concurrency
 * two, where the first worker has finished and the second has not, and the
 * sweep reports the first one's outcome.
 */
test("once rows have writers of their own, an unaddressed event is never the last one running's", () => {
  const running = addressed(
    [0, SWEEP],
    [1, { kind: "step", name: "FAB-5-42", at: 1, of: 3, state: "start" }],
    [1, { kind: "step", name: "pr-41", at: 2, of: 3, state: "start" }],
    [2, { kind: "step", name: "FAB-5-42", at: 1, of: 3, state: "end", seconds: 1, outcome: "done" }],
  );
  const one = running.roots[0]!.children.filter((row) => row.state === "running");
  assert.equal(one.length, 1, "exactly one row is left running, which is the trap");

  const told = take(bound(running, "pr-41", "/worktrees/pr-41"), noon + 3000, "  #42 [yours] a thing — synced: pushed 9f1c2ab");
  assert.deepEqual(told.roots[0]!.children.map((row) => row.stream.length), [0, 0, 0], "the line is in no row's window");
  assert.equal(told.roots[0]!.stream.length, 1, "it is the sweep's own");
});
