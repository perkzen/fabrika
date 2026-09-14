import assert from "node:assert/strict";
import { test } from "node:test";
import { frame, type View } from "../src/terminal/frame.ts";
import { outline, type Tree } from "../src/domain/outline.ts";
import type { RunEvent } from "../src/domain/run-event.ts";

const noon = new Date(2026, 0, 1, 12, 0, 0).getTime();

/** The identity styler: a test asserts on the text, never on the escape codes around it. */
const bare = (_style: unknown, text: string) => text;

/** What the operator actually sees: the escape codes stripped back out. */
const visible = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const script = (label: string, ...events: ReadonlyArray<readonly [number, RunEvent | string]>): Tree => ({
  ...outline(events.map(([seconds, entry]) => ({ when: noon + seconds * 1000, entry }))),
  label,
});

const view: View = { selected: "0:2", opened: null, chosen: false, scroll: 0, top: 0 };

const RUN: RunEvent = {
  kind: "run",
  completed: [],
  steps: [{ name: "preflight", done: false }, { name: "implement", done: false }, { name: "review", done: false }],
};

test("a frame is exactly rows lines, each at most columns - 1 wide", () => {
  const tree = script("FAB-6", [0, RUN], [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }]);
  const lines = frame(tree, view, { columns: 40, rows: 10 }, bare, { now: noon + 1000, spin: 0 });

  assert.equal(lines.length, 10, "the cursor arithmetic is only trivial while one line is one row");
  for (const line of lines) assert.ok(line.length <= 39, `"${line}" is wider than columns - 1`);
  assert.deepEqual(lines.slice(0, 4), [
    "FAB-6  [████░░░░░░░░] 2/3 implement  1s",
    " ○ preflight",
    " ⠋ implement       0s",
    " ○ review",
  ]);
  assert.deepEqual(lines.slice(4), Array<string>(6).fill(""), "the rest of the viewport is blank, not stale");
});

/** The tree the run is in, as `run.ts` hands it to the presenter: absolute, under the operator's home. */
const WORKTREE = "/Users/x/.fabrika/worktrees/fabrika/FAB-7";

test("the worktree is the header's second row, abbreviated against the operator's home", () => {
  const tree: Tree = {
    ...script("FAB-7", [0, RUN], [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }]),
    worktree: WORKTREE,
  };
  const lines = frame(tree, view, { columns: 80, rows: 12 }, bare, { now: noon + 1000, spin: 0 }, { home: "/Users/x" });

  assert.equal(lines.length, 12, "the row it takes comes out of the body, never out of the frame");
  for (const line of lines) assert.ok(line.length <= 79, `"${line}" is wider than columns - 1`);
  assert.deepEqual(
    lines.slice(0, 5),
    [
      "FAB-7  [████░░░░░░░░] 2/3 implement  1s",
      "~/.fabrika/worktrees/fabrika/FAB-7",
      " ○ preflight",
      " ⠋ implement       0s",
      " ○ review",
    ],
    "the path is directly under the progress row, and the outline follows it",
  );
});

test("only the home directory and what is under it is written as ~", () => {
  const started = script("FAB-7", [0, RUN]);
  const size = { columns: 80, rows: 12 };
  const at = (worktree: string, home?: string) =>
    frame({ ...started, worktree }, view, size, bare, { now: noon, spin: 0 }, home === undefined ? {} : { home })[1];

  assert.equal(at("/Users/xtra/work/FAB-7", "/Users/x"), "/Users/xtra/work/FAB-7", "a neighbour of home is not under it");
  assert.equal(at("/Users/x", "/Users/x"), "~", "home itself is the one the operator writes as ~");
  assert.equal(at(WORKTREE), WORKTREE, "no home to write it against, so it is written whole");
});

test("the worktree row is viewport furniture, dropped at the height the keys row is", () => {
  const started: ReadonlyArray<readonly [number, RunEvent | string]> = [
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
  ];
  const tree: Tree = { ...script("FAB-7", ...started), worktree: WORKTREE };
  const cramped = frame(tree, view, { columns: 80, rows: 11 }, bare, { now: noon + 1000, spin: 0 }, { home: "/Users/x" });

  assert.equal(cramped.length, 11);
  assert.deepEqual(
    cramped.slice(0, 4),
    ["FAB-7  [████░░░░░░░░] 2/3 implement  1s", " ○ preflight", " ⠋ implement       0s", " ○ review"],
    "under twelve rows the path goes the way the keys do, and the outline keeps every step",
  );
  assert.equal(cramped.at(-1), "", "the rows it gave up are the body's, not another row of furniture");

  const noTree = frame(script("FAB-7", ...started), view, { columns: 80, rows: 12 }, bare, { now: noon + 1000, spin: 0 }, { home: "/Users/x" });
  assert.equal(noTree[1], " ○ preflight", "a run with no worktree has no second header row at any height");
});

test("a row too wide for the terminal is cut rather than wrapped", () => {
  const tree = script("FAB-6", [0, RUN]);
  const lines = frame(tree, view, { columns: 12, rows: 4 }, bare, { now: noon, spin: 0 });
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.slice(1), [" ○ prefligh", " ○ implemen", " ○ review"]);
});

const FINISHED: ReadonlyArray<readonly [number, RunEvent | string]> = [
  [0, RUN],
  [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
  [2, { kind: "tool", stage: "implement", tool: "Skill", subject: "fabrika:tdd" }],
  [3, { kind: "tool", stage: "implement", tool: "Bash", subject: "pnpm test" }],
  [4, { kind: "tool", stage: "implement", tool: "Bash", subject: "git commit" }],
  [5, { kind: "tool", stage: "implement", tool: "Edit", subject: "src/cli.ts" }],
  [6, { kind: "cost", stage: "implement", usd: 0.25 }],
  [7, { kind: "cost", stage: "implement", usd: 0.5 }],
  [8, { kind: "gate", name: "compile", at: 1, of: 2, command: "tsc", state: "pass", seconds: 3 }],
  [9, { kind: "gate", name: "test", at: 2, of: 2, command: "pnpm test", state: "fail", seconds: 41, exitCode: 1 }],
  [533, { kind: "step", name: "implement", at: 2, of: 3, state: "end", seconds: 533, outcome: "done" }],
];

test("a finished step's line carries its summary in field order", () => {
  const tree = script("FAB-6", ...FINISHED);
  const lines = frame(tree, view, { columns: 200, rows: 5 }, bare, { now: noon, spin: 0 });

  assert.equal(
    lines[2],
    " ✔ implement   8m 53s   $0.75  4 calls (Bash 2, Edit 1, Skill 1)  fabrika:tdd  gate: compile ok 3s, test FAILED 41s",
  );
});

test("a step that made one tool call says so in the singular", () => {
  const tree = script(
    "FAB-6",
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [2, { kind: "tool", stage: "implement", tool: "Skill", subject: "fabrika:tdd" }],
    [3, { kind: "step", name: "implement", at: 2, of: 3, state: "end", seconds: 4, outcome: "done" }],
  );
  const lines = frame(tree, view, { columns: 200, rows: 5 }, bare, { now: noon, spin: 0 });
  assert.equal(lines[2], " ✔ implement       4s          1 call (Skill 1)  fabrika:tdd", "a step that cost nothing leaves its cost column blank, so the calls line up");
});

test("a summary naming more than three tools says how many it left out", () => {
  const many = ["Bash", "Bash", "Bash", "Edit", "Edit", "Read", "Glob", "Grep"].map(
    (tool, index) => [index + 2, { kind: "tool", stage: "implement", tool, subject: "x" }] as const,
  );
  const tree = script(
    "FAB-6",
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    ...many,
    [20, { kind: "step", name: "implement", at: 2, of: 3, state: "end", seconds: 12, outcome: "failed" }],
  );
  const lines = frame(tree, view, { columns: 200, rows: 5 }, bare, { now: noon, spin: 0 });

  assert.equal(lines[2], " ✖ implement      12s          8 calls (Bash 3, Edit 2, Glob 1, +2 more)");
});

test("a skipped step carries its reason instead of a summary", () => {
  const tree = script(
    "FAB-6",
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "skipped", reason: "fix ticket; runs for feat" }],
  );
  const lines = frame(tree, view, { columns: 200, rows: 5 }, bare, { now: noon, spin: 0 });
  assert.equal(lines[2], " – implement  skipped (fix ticket; runs for feat)");
});

test("a summary is truncated from the right, so the marker, title and state survive", () => {
  const tree = script("FAB-6", ...FINISHED);
  const lines = frame(tree, view, { columns: 28, rows: 5 }, bare, { now: noon, spin: 0 });

  assert.equal(lines[2], " ✔ implement   8m 53s   $0.", "cut at columns - 1, the marker and the title intact");
});

test("a failed gate stays bold red inside the summary, and the rest of the row is not", () => {
  const tree = script("FAB-6", ...FINISHED);
  const dressed: Array<[unknown, string]> = [];
  frame(tree, view, { columns: 200, rows: 5 }, (style, text) => {
    dressed.push([style, text]);
    return text;
  }, { now: noon, spin: 0 });

  assert.ok(
    dressed.some(([style, text]) => text === "test FAILED 41s" && JSON.stringify(style) === '["bold","red"]'),
    "the one line the operator does read is the one that is wrong",
  );
  assert.ok(
    dressed.every(([, text]) => text !== "compile ok 3s"),
    "a gate that passed is dressed by nothing, so it recedes behind the one that did not",
  );
});

const WATCHING: ReadonlyArray<readonly [number, RunEvent | string]> = [
  [0, RUN],
  [0, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
  [1, { kind: "tool", stage: "implement", tool: "Read", subject: "src/cli.ts" }],
  [2, { kind: "agent", stage: "implement", markdown: "on it" }],
  [3, { kind: "tool", stage: "implement", tool: "Bash", subject: "pnpm test" }],
];

/** The operator watching the running step, which is the default view. */
const watching: View = { selected: "0:2", opened: "0:2", chosen: false, scroll: 0, top: 0 };

test("the open step's stream fills the rest of the frame, stamped and tail-aligned under its line", () => {
  const tree = script("FAB-6", ...WATCHING);
  const lines = frame(tree, watching, { columns: 60, rows: 10 }, bare, { now: noon + 3000, spin: 0 });

  assert.deepEqual(lines, [
    "FAB-6  [████░░░░░░░░] 2/3 implement  3s",
    " ○ preflight",
    " ⠋ implement       3s",
    "   12:00:01   Read src/cli.ts",
    "   12:00:02 │ on it",
    "   12:00:03   Bash pnpm test",
    "",
    "",
    "",
    " ○ review",
  ], "the detail is folded under the step it belongs to, indented under its title, and the steps after it follow the window");
});

test("a window row is wrapped rather than cut, because a window exists to read prose", () => {
  const tree = script(
    "FAB-6",
    [0, RUN],
    [0, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [1, { kind: "agent", stage: "implement", markdown: "the gate is red and the fix is small" }],
  );
  const lines = frame(tree, watching, { columns: 30, rows: 10 }, bare, { now: noon, spin: 0 });

  assert.deepEqual(lines.slice(3, 6), [
    "   12:00:01 │ the gate is red",
    "    and the fix is small",
    "",
  ], "a cut sentence defeats the one thing a window is for, and a continuation keeps the indent");
  for (const line of lines) assert.ok(line.length <= 29);
});

test("wrapping counts display columns, so a styled line is not broken inside its escape", () => {
  const tree = script(
    "FAB-6",
    [0, RUN],
    [0, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [1, { kind: "agent", stage: "implement", markdown: "**the gate is red** and the fix is small" }],
  );
  const dressed = frame(tree, watching, { columns: 30, rows: 10 }, (style, text) => `\x1b[1m${text}\x1b[22m`, {
    now: noon,
    spin: 0,
  });

  const row = dressed[3]!;
  assert.ok(row.length > 29, "the escapes are really there");
  assert.equal(visible(row).length, 29, "and they cost the row no columns");
  assert.equal(visible(dressed[4]!), "    and the fix is small");
});

test("the window shrinks before the outline does, and never below three rows", () => {
  const tree = script("FAB-6", ...WATCHING);

  const roomy = frame(tree, watching, { columns: 60, rows: 8 }, bare, { now: noon, spin: 0 });
  assert.deepEqual(roomy.slice(0, 3).concat(roomy.slice(7)), [
    "FAB-6  [████░░░░░░░░] 2/3 implement  0s",
    " ○ preflight",
    " ⠋ implement       0s",
    " ○ review",
  ], "the outline is whole and the window took the four rows left over");

  const cramped = frame(tree, watching, { columns: 60, rows: 5 }, bare, { now: noon, spin: 0 });
  assert.deepEqual(cramped, [
    "FAB-6  [████░░░░░░░░] 2/3 implement  0s",
    " ⠋ implement       0s",
    "   12:00:01   Read src/cli.ts",
    "   12:00:02 │ on it",
    "   12:00:03   Bash pnpm test",
  ], "the window keeps its three rows and the outline scrolls to the selected step, rather than losing them");

  const tiny = frame(tree, watching, { columns: 60, rows: 4 }, bare, { now: noon, spin: 0 });
  assert.deepEqual(tiny, [
    "FAB-6  [████░░░░░░░░] 2/3 implement  0s",
    " ○ preflight",
    " ⠋ implement       0s",
    " ○ review",
  ], "under five rows a window cannot have its three, and the thing always needed is the outline");
});

test("the footer names the keys, and is the row dropped first when rows are scarce", () => {
  const tree = script("FAB-6", [0, RUN]);

  const roomy = frame(tree, view, { columns: 80, rows: 12 }, bare, { now: noon, spin: 0 });
  assert.equal(roomy.length, 12);
  assert.match(roomy.at(-1)!, /↑↓ select/, "keys nobody can discover are keys nobody uses");
  assert.equal(roomy[10], "", "and it is the last row, not a row in the middle of the padding");

  const cramped = frame(tree, view, { columns: 80, rows: 11 }, bare, { now: noon, spin: 0 });
  assert.equal(cramped.length, 11);
  assert.equal(cramped.at(-1), "", "under twelve rows it is the row worth losing first");
});

test("the keys row names o open exactly when there is an editor to open with", () => {
  const tree = script("FAB-7", [0, RUN]);
  const size = { columns: 80, rows: 12 };
  const named = (operator?: { editor: boolean }) => frame(tree, view, size, bare, { now: noon, spin: 0 }, operator).at(-1);

  assert.equal(
    named({ editor: true }),
    "↑↓ select · space fold · PgUp/PgDn scroll · Esc follow · o open · ^C interrupt",
    "still inside an eighty-column terminal, with Ctrl-C last as the most drastic key",
  );
  const silent = "↑↓ select · space fold · PgUp/PgDn scroll · Esc follow · ^C interrupt";
  assert.equal(named({ editor: false }), silent, "a machine with no editor command is never shown a key that does nothing");
  assert.equal(named(), silent);
});

test("an open wait's spinner, elapsed and deadline are the window's last row", () => {
  const tree = script(
    "FAB-6",
    [0, RUN],
    [0, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [1, { kind: "tool", stage: "implement", tool: "Read", subject: "src/cli.ts" }],
    [1, { kind: "wait", state: "start", subject: "implement agent", deadlineMinutes: 25 }],
  );
  const lines = frame(tree, watching, { columns: 60, rows: 10 }, bare, { now: noon + 253_000, spin: 0 });

  assert.deepEqual(lines.slice(3), [
    "   12:00:01   Read src/cli.ts",
    "   12:00:01 waiting for implement agent",
    "",
    "",
    "",
    "   ⠋ waiting for implement agent — 4m 12s / 25m",
    " ○ review",
  ], "the liveness moves under the running step's line, where the work is");

  const later = frame(tree, watching, { columns: 60, rows: 10 }, bare, { now: noon + 253_000, spin: 1 });
  assert.notEqual(later[8]!.trimStart()[0], lines[8]!.trimStart()[0], "the frame advances, which is what proves the run is alive");
});

test("a running gate's n/N and the command it is on take that row instead", () => {
  const tree = script(
    "FAB-6",
    [0, RUN],
    [0, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [1, { kind: "gate", name: "compile", at: 1, of: 2, command: "tsc --noEmit", state: "start" }],
  );
  const lines = frame(tree, watching, { columns: 60, rows: 10 }, bare, { now: noon + 1000, spin: 0 });
  assert.equal(lines[8], "   gate 1/2 compile: tsc --noEmit", "the gate's liveness survives the new shape");

  // A gate is over when it fails or when its last step is behind it — the same
  // rule the scrollback console's live region follows.
  const done = script(
    "FAB-6",
    [0, RUN],
    [0, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [1, { kind: "gate", name: "compile", at: 1, of: 2, command: "tsc --noEmit", state: "start" }],
    [2, { kind: "gate", name: "compile", at: 1, of: 2, command: "tsc --noEmit", state: "pass", seconds: 3 }],
    [3, { kind: "gate", name: "test", at: 2, of: 2, command: "pnpm test", state: "start" }],
    [4, { kind: "gate", name: "test", at: 2, of: 2, command: "pnpm test", state: "pass", seconds: 41 }],
  );
  assert.equal(frame(done, watching, { columns: 60, rows: 10 }, bare, { now: noon, spin: 0 })[8], "");
});

test("a finished step's window shows its stream and no liveness, the run having moved on", () => {
  const tree = script(
    "FAB-6",
    [0, RUN],
    [0, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [1, { kind: "wait", state: "start", subject: "implement agent", deadlineMinutes: 25 }],
    [2, { kind: "step", name: "implement", at: 2, of: 3, state: "end", seconds: 2, outcome: "done" }],
  );
  const lines = frame(tree, watching, { columns: 60, rows: 10 }, bare, { now: noon + 253_000, spin: 0 });
  assert.equal(lines[3], "   12:00:01 waiting for implement agent");
  assert.equal(lines[8], "", "the spinner belongs to the running step, and this one is over");
});

test("the running step's marker turns with the clock, and no other step's does", () => {
  const tree = script("FAB-6", ...WATCHING);
  const size = { columns: 60, rows: 10 };

  const first = frame(tree, watching, size, bare, { now: noon, spin: 0 });
  const later = frame(tree, watching, size, bare, { now: noon, spin: 1 });

  assert.equal(first[2], " ⠋ implement       0s");
  assert.equal(later[2], " ⠙ implement       0s", "a still marker is what a hung run looks like");
  assert.equal(first[1], later[1], "a pending step is not doing anything, so nothing about it moves");
});

test("a step is coloured by its state, marker and title as one", () => {
  const tree = script(
    "FAB-6",
    [0, RUN],
    [1, { kind: "step", name: "preflight", at: 1, of: 3, state: "start" }],
    [2, { kind: "step", name: "preflight", at: 1, of: 3, state: "end", seconds: 2, outcome: "done" }],
    [3, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
  );
  const dressed: Array<[unknown, string]> = [];
  frame(tree, { ...view, selected: "" }, { columns: 60, rows: 10 }, (style, text) => (dressed.push([style, text]), text), {
    now: noon,
    spin: 0,
  });

  const styleOf = (text: string) => JSON.stringify(dressed.find(([, drawn]) => drawn === text)?.[0]);
  assert.equal(styleOf("✔ preflight"), '["bold","green"]', "what is finished is green, marker and title in one segment");
  assert.equal(styleOf("⠋ implement"), '["bold","cyan"]', "and the one thing happening is not");
  assert.equal(styleOf("○ review"), '"dim"', "a step that has not started recedes, so the eye lands on the two above it");
});

test("the selected row is marked, so moving the selection is something the operator can see", () => {
  const tree = script("FAB-6", ...WATCHING);
  const dressed: Array<[unknown, string]> = [];
  const spy = (style: unknown, text: string) => (dressed.push([style, text]), text);

  const lines = frame(tree, { ...watching, selected: "0:1" }, { columns: 60, rows: 10 }, spy, { now: noon, spin: 0 });

  assert.ok(
    dressed.some(([style, text]) => text === "○ preflight" && style === "inverse"),
    "picking a step to read means seeing which one is picked; dim is no colour, so the mark on a queued row is the inverse alone",
  );
  assert.ok(
    !dressed.some(([style, text]) => text.startsWith("⠋ implement") && JSON.stringify(style).includes("inverse")),
    "and only one is",
  );
  assert.equal(lines[1], " ○ preflight", "the marking is dressing, so the line's text is the one the spec pins");
});

const LONG: RunEvent = {
  kind: "run",
  completed: [],
  steps: Array.from({ length: 11 }, (_, index) => ({ name: `step${index + 1}`, done: false })),
};

test("an outline longer than the terminal scrolls to keep the selected step on screen", () => {
  const tree = script("FAB-6", [0, LONG]);
  const size = { columns: 60, rows: 8 };

  const bottom = frame(tree, { ...view, selected: "0:11", opened: null, top: 0 }, size, bare, { now: noon, spin: 0 });
  assert.equal(bottom.length, 8);
  assert.equal(bottom[1], " ○ step5", "a stale top is pulled down until the selection is on screen");
  assert.equal(bottom.at(-1), " ○ step11");

  const top = frame(tree, { ...view, selected: "0:1", opened: null, top: 9 }, size, bare, { now: noon, spin: 0 });
  assert.equal(top[1], " ○ step1 ", "and pushed back up the same way; the selected title runs its column, which is where its mark is");
  assert.equal(top.at(-1), " ○ step7");

  const held = frame(tree, { ...view, selected: "0:6", opened: null, top: 3 }, size, bare, { now: noon, spin: 0 });
  assert.equal(held[1], " ○ step4", "a top the selection already fits in is left where the operator put it");
});

test("wrapping never splits a character in half, whatever column it lands on", () => {
  // An agent writes emoji constantly, and one is two UTF-16 units: broken
  // across a row boundary it renders as two pieces of garbage.
  for (let pad = 0; pad < 24; pad += 1) {
    const tree = script(
      "FAB-6",
      [0, RUN],
      [0, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
      [1, { kind: "agent", stage: "implement", markdown: `${"x".repeat(pad)}😀 the gate is red` }],
    );
    const lines = frame(tree, watching, { columns: 20, rows: 10 }, bare, { now: noon, spin: 0 });

    assert.ok(lines.join("").includes("😀"), `at offset ${pad} the character survived whole`);
    for (const line of lines) {
      assert.doesNotMatch(line, /[\uD800-\uDBFF]$/, `at offset ${pad}, a row ends on half a character`);
      assert.doesNotMatch(line, /^[\uDC00-\uDFFF]/, `at offset ${pad}, a row starts on half a character`);
    }
  }
});

test("a tab is a space by the time it reaches the terminal, because it costs more columns than it counts", () => {
  const tree = script(
    "FAB-6",
    [0, { kind: "run", completed: [], steps: [{ name: "pre\tflight", done: false }, { name: "implement", done: false }, { name: "review", done: false }] }],
    [0, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    // A fenced block is walked verbatim, and an agent reading a tab-indented
    // repo puts one on screen every few minutes.
    [1, { kind: "agent", stage: "implement", markdown: "```go\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n```" }],
  );
  const lines = frame(tree, watching, { columns: 30, rows: 12 }, bare, { now: noon, spin: 0 });

  assert.equal(lines.length, 12, "the frame is still exactly rows lines");
  for (const line of lines) {
    assert.ok(!line.includes("\t"), `"${line}" carries a tab, which the terminal widens to the next tab stop`);
    assert.ok(line.length <= 29, `"${line}" is wider than columns - 1`);
  }
  assert.deepEqual(
    lines.slice(1, 8),
    [
      " ○ pre flight",
      " ⠋ implement        0s",
      "   12:00:01 │   go",
      "   12:00:01 │   func main() {",
      "   12:00:01 │    fmt.Println(",
      '   "hi")',
      "   12:00:01 │   }",
    ],
    "a tab is one column wherever it lands, and one in a code block still indents the line it is on",
  );
});

test("below the window's floor the outline takes every row, so a fold costs no step its line", () => {
  // Four rows leave a header and three: not enough for a window's floor of
  // three, so Q24's rule is that the outline gets all of them and a fold
  // shows nothing. The liveness row is part of the window and goes with it.
  const tree = script(
    "FAB-6",
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [2, { kind: "wait", state: "start", subject: "implement agent", deadlineMinutes: 5 }],
  );
  const lines = frame(tree, { ...view, selected: "0:2", opened: "0:2" }, { columns: 60, rows: 4 }, bare, {
    now: noon + 4000,
    spin: 0,
  });

  assert.equal(lines.length, 4);
  assert.deepEqual(lines.slice(1), [" ○ preflight", " ⠋ implement       3s", " ○ review"], "no step loses its row to a window that was not drawn");
});

test("a scrolled outline keeps the running step on screen too, until the selection needs the room", () => {
  // Story 38 asks for both: the operator has moved the selection back to step
  // 2 to read it while the run is on step 6.
  const size = { columns: 60, rows: 6 };
  const running = (at: number): Tree =>
    script("FAB-6", [0, LONG], [1, { kind: "step", name: `step${at}`, at, of: 11, state: "start" }]);
  const chosen = { ...view, selected: "0:2", opened: null, chosen: true, top: 0 };

  const both = frame(running(6), chosen, size, bare, { now: noon, spin: 0 });
  assert.equal(both[1], " ○ step2 ", "the outline is pulled down far enough to hold both");
  assert.equal(both.at(-1), " ⠋ step6        0s", "and the running step is the last row rather than off screen");

  // Five rows cannot hold steps 2 and 10 at once, and the selection is the
  // operator's choice while the running step already has the window.
  const apart = frame(running(10), chosen, size, bare, { now: noon, spin: 0 });
  assert.equal(apart[1], " ○ step1");
  assert.equal(apart.at(-1), " ○ step5", "too far apart, so the selection wins");
});

test("a resumed run reads the same as a fresh one: the step behind it says so on its own line", () => {
  const tree = script("FAB-6", [
    0,
    {
      kind: "run",
      completed: ["preflight"],
      steps: [{ name: "preflight", done: true }, { name: "implement", done: false }, { name: "review", done: false }],
    },
  ], [1, { kind: "step", name: "implement", at: 2, of: 3, state: "skipped", reason: "fix ticket; runs for feat" }]);
  const lines = frame(tree, view, { columns: 80, rows: 6 }, bare, { now: noon, spin: 0 });

  assert.equal(lines[1], " ✔ preflight  already done");
  assert.equal(lines[2], " – implement  skipped (fix ticket; runs for feat)", "a skip carries its reason instead of a summary");
});

test("a cut row never splits a character in half either, whatever width the terminal is", () => {
  // `wrap` counts code points; `row` cut by UTF-16 units, so the same emoji
  // that survives a wrapped window came apart in an outline row.
  const tree = script("FAB-6", [
    0,
    { kind: "run", completed: [], steps: [{ name: "implement 🚀 the thing", done: false }] },
  ]);
  const half = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  for (let columns = 8; columns < 30; columns += 1) {
    const line = frame(tree, { ...view, selected: "0:1" }, { columns, rows: 3 }, bare, { now: noon, spin: 0 })[1]!;
    assert.doesNotMatch(line, half, `"${line}" at ${columns} columns carries half a character`);
    assert.ok([...line].length <= columns - 1, `"${line}" is wider than columns - 1`);
  }
});

test("dressing a frame changes its bytes and never how many rows it has", () => {
  // `scrolled()` counts a window's rows with the identity styler while the
  // screen draws it with a real one; the clamp is only right while those agree.
  const dim = (_style: unknown, text: string) => `\x1b[2m${text}\x1b[22m`;
  const tree = script(
    "FAB-6",
    [0, RUN],
    [1, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [2, { kind: "agent", stage: "implement", markdown: "# a heading\n\nand a paragraph long enough to wrap more than once across a narrow window" }],
  );
  const open = { ...view, selected: "0:2", opened: "0:2" };
  const size = { columns: 40, rows: 14 };

  const plain = frame(tree, open, size, bare, { now: noon, spin: 0 });
  const dressed = frame(tree, open, size, dim, { now: noon, spin: 0 });

  assert.equal(dressed.length, plain.length);
  assert.deepEqual(dressed.map(visible), plain, "the same rows, with escapes around them");
});

const TITLED: RunEvent = {
  kind: "run",
  completed: [],
  steps: [
    { name: "preflight", title: "Preflight", about: "config check", done: false },
    { name: "implement", title: "Implement", about: "agent · gate", done: false },
    { name: "review", title: "Review loop", about: "reviewer rounds", done: false },
  ],
};

test("a step is called by its title, and what follows the title is by state", () => {
  // The name keys the completed list, the config and every plain line; the
  // title is the pipeline's word for the reader, and no row shows a position
  // because the header already does.
  const tree = script(
    "FAB-6",
    [0, TITLED],
    [0, { kind: "step", name: "preflight", at: 1, of: 3, state: "start" }],
    [2, { kind: "step", name: "preflight", at: 1, of: 3, state: "end", seconds: 2, outcome: "done" }],
    [2, { kind: "step", name: "implement", at: 2, of: 3, state: "start" }],
    [2, { kind: "cost", stage: "implement", usd: 0.4 }],
  );
  const dressed: Array<[unknown, string]> = [];
  const spy = (style: unknown, text: string) => (dressed.push([style, text]), text);
  const lines = frame(tree, { ...view, selected: "" }, { columns: 80, rows: 6 }, spy, { now: noon + 75_000, spin: 0 });

  assert.deepEqual(lines.slice(0, 4), [
    "FAB-6  [████░░░░░░░░] 2/3 Implement  1m 15s  $0.40",
    " ✔ Preflight         2s",
    " ⠋ Implement     1m 13s",
    " ○ Review loop  reviewer rounds",
  ], "the header says what the run has taken so far; a finished row what it took, a running row how long it has been at it, a pending row what it will do");
  assert.ok(
    dressed.some(([style, text]) => text === "  reviewer rounds" && style === "dim"),
    "what a pending step will do recedes with the step, so the queue reads as one dim block under the running row",
  );
  assert.equal(
    frame(tree, { ...view, selected: "" }, { columns: 80, rows: 6 }, bare, { now: noon + 76_000, spin: 0 })[2],
    " ⠋ Implement     1m 14s",
    "the running row's time turns with the clock, so a step whose agent has said nothing for minutes still reads as alive",
  );
});

test("titles are padded to the widest in the run, so every row's detail starts on one column", () => {
  const wide: RunEvent = {
    kind: "run",
    completed: [],
    steps: [
      { name: "a", title: "Go", done: false },
      { name: "b", title: "A stage with a very long name", done: false },
      { name: "c", title: "Short", about: "agent", done: false },
    ],
  };
  const tree = script("FAB-6", [0, wide], [0, { kind: "step", name: "a", at: 1, of: 3, state: "start" }]);
  const lines = frame(tree, { ...view, selected: "" }, { columns: 80, rows: 6 }, bare, { now: noon, spin: 0 });

  assert.equal(lines[1], " ⠋ Go                         0s", "the column is the widest title's, up to the cap");
  assert.equal(lines[2], " ○ A stage with a very…", "past the cap a title is cut with an ellipsis, so one name cannot push every row's detail off the right");
  assert.equal(lines[3], " ○ Short                 agent");
});

/**
 * A sweep is the run with several steps open at once — the one shape a run
 * never has. Everything below is driven the same way the rest of this file is:
 * a scripted event list, addressed to a row where a worker wrote it, with no
 * terminal and no clock of its own.
 */
const SWEEP: RunEvent = {
  kind: "run",
  completed: [],
  steps: [
    { name: "FAB-5-42", title: "#42 FAB-5", about: "[yours] Conflicted PRs pile up — would sync branch-42 into origin/main", done: false },
    { name: "pr-41", title: "#41", about: "[fabrika] fix: second", done: false },
    { name: "FAB-9-40", title: "#40 FAB-9", about: "[yours] A third thing — would sync branch-40 into origin/main", done: false },
  ],
};

/** The same script, with an address on the entries a worker wrote. */
const swept = (...events: ReadonlyArray<readonly [number, RunEvent | string, string?]>): Tree => ({
  ...outline(events.map(([seconds, entry, address]) => ({ when: noon + seconds * 1000, entry, address }))),
  label: "perkzen/fabrika",
});

const began = (name: string, title: string, at: number): RunEvent => ({ kind: "step", name, title, at, of: 3, state: "start" });

test("a sweep's outline is one row per pull request, the skipped ones present and dimmed", () => {
  const tree = swept(
    [0, SWEEP],
    [0, { kind: "step", name: "pr-41", title: "#41", at: 2, of: 3, state: "skipped", reason: "branch is checked out at /dev/fabrika" }],
    [1, began("FAB-5-42", "#42 FAB-5", 1)],
    [2, began("FAB-9-40", "#40 FAB-9", 3)],
  );
  const dressed: Array<[unknown, string]> = [];
  const spy = (style: unknown, text: string) => (dressed.push([style, text]), text);
  const lines = frame(tree, { ...view, selected: "" }, { columns: 90, rows: 6 }, spy, { now: noon + 5000, spin: 0 });

  assert.deepEqual(lines.slice(0, 4), [
    "perkzen/fabrika  [████████░░░░] 3/3 #40 FAB-9  5s",
    " ⠋ #42 FAB-5       4s",
    " – #41        skipped (branch is checked out at /dev/fabrika)",
    " ⠋ #40 FAB-9       3s",
  ], "the row count is the answer the scrollback's `N conflicted, M skipped` line gives");
  assert.ok(
    dressed.some(([style, text]) => text.startsWith("– #41") && style === "dim"),
    "a skipped row is present and dimmed rather than absent",
  );
});

test("several rows run at once and each one's events land under its own row", () => {
  const events: ReadonlyArray<readonly [number, RunEvent | string, string?]> = [
    [0, SWEEP],
    [1, began("FAB-5-42", "#42 FAB-5", 1)],
    [1, began("pr-41", "#41", 2)],
    [1, began("FAB-9-40", "#40 FAB-9", 3)],
    // Interleaved, the way three workers write: the address is the only thing
    // that says where each one goes.
    [2, "worktree /worktrees/pr-41", "pr-41"],
    [3, "worktree /worktrees/FAB-5-42", "FAB-5-42"],
    [4, { kind: "note", level: "detail", text: "base moved: 3 commit(s) behind; merging" }, "FAB-9-40"],
    [5, { kind: "tool", stage: "sync", tool: "Edit", subject: "src/b.ts" }, "pr-41"],
    [6, { kind: "agent", stage: "sync", markdown: "resolving src/a.ts" }, "FAB-5-42"],
  ];
  const tree = swept(...events);
  const size = { columns: 90, rows: 20 };
  const window = (key: string) =>
    frame(tree, { ...view, selected: key, opened: key, chosen: true, scroll: 0, top: 0 }, size, bare, { now: noon + 6000, spin: 0 })
      .join("\n");

  const first = window("0:1");
  assert.ok(first.includes("12:00:03 worktree /worktrees/FAB-5-42"), `the first row's own lines:\n${first}`);
  assert.ok(first.includes("│ resolving src/a.ts"), "its agent's speech with it");
  assert.ok(!first.includes("/worktrees/pr-41") && !first.includes("base moved"), "and nothing from either sibling");

  const second = window("0:2");
  assert.ok(second.includes("12:00:02 worktree /worktrees/pr-41") && second.includes("Edit src/b.ts"), `the second row's own lines:\n${second}`);
  assert.ok(!second.includes("/worktrees/FAB-5-42") && !second.includes("base moved"), "and nothing from either sibling");

  const third = window("0:3");
  assert.ok(third.includes("base moved: 3 commit(s) behind; merging"), `the third row's own lines:\n${third}`);
  assert.ok(!third.includes("/worktrees/pr-41") && !third.includes("/worktrees/FAB-5-42"), "and nothing from either sibling");
});

/**
 * Six workers each have an open agent call, and a single wait per tree would
 * have them blanking each other's liveness — `parallel-run.md` finding 1 names
 * the same defect for a single run's two concurrent waits.
 */
test("one row's wait ending leaves the rows still waiting animating", () => {
  const events: ReadonlyArray<readonly [number, RunEvent | string, string?]> = [
    [0, SWEEP],
    [1, began("FAB-5-42", "#42 FAB-5", 1)],
    [1, began("pr-41", "#41", 2)],
    [2, { kind: "wait", state: "start", subject: "the merge agent", deadlineMinutes: 25 }, "FAB-5-42"],
    [3, { kind: "wait", state: "start", subject: "the merge agent", deadlineMinutes: 25 }, "pr-41"],
    [4, { kind: "wait", state: "end", subject: "the merge agent", seconds: 1 }, "pr-41"],
  ];
  const tree = swept(...events);
  const size = { columns: 90, rows: 20 };
  const rows = (key: string) =>
    frame(tree, { ...view, selected: key, opened: key, chosen: true, scroll: 0, top: 0 }, size, bare, { now: noon + 254_000, spin: 0 });

  assert.equal(
    rows("0:1").filter((line) => line.includes("waiting for")).at(-1),
    "   ⠋ waiting for the merge agent — 4m 12s / 25m",
    "the row that is still waiting still says so, and still turns",
  );
  assert.ok(
    !rows("0:2").some((line) => line.trimStart().startsWith("⠋ waiting for")),
    "and the row whose wait ended has no liveness row at all",
  );
});

test("the sweep's own lines are the sweep's, not the first worker's", () => {
  const tree = swept(
    [0, SWEEP],
    [1, began("FAB-5-42", "#42 FAB-5", 1)],
    [1, began("pr-41", "#41", 2)],
    // The fan-out's own wait, and the line a worker's outcome is reported on:
    // neither is addressed, and with two rows open neither is any one row's.
    [2, { kind: "wait", state: "start", subject: "syncing 2 pull request(s)" }],
    [3, { kind: "note", level: "detail", text: "#41 [fabrika] fix: second — synced: pushed 9f1c2ab" }],
  );
  const size = { columns: 90, rows: 20 };
  const shown = (key: string) =>
    frame(tree, { ...view, selected: key, opened: key, chosen: true, scroll: 0, top: 0 }, size, bare, { now: noon + 4000, spin: 0 }).join("\n");

  for (const key of ["0:1", "0:2"]) {
    assert.ok(!shown(key).includes("synced: pushed 9f1c2ab"), `an unaddressed line is in no row's window (${key})`);
    assert.ok(!shown(key).includes("waiting for syncing"), `and neither is the fan-out's own wait (${key})`);
  }
});
