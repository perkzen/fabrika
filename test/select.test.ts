import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_TEMPLATE, type Config } from "../src/config.ts";
import {
  abandoned,
  bulk,
  canAnswer,
  chosen,
  decode,
  lines,
  picker,
  press,
  settled,
  type Picker,
} from "../src/terminal/select.ts";
import type { Style } from "../src/terminal/console.ts";

/** The identity styler `frame.test.ts` uses: what a line says is testable, how it is dressed is the terminal's. */
const plain = (_style: Style | undefined, text: string) => text;
const SIZE = { columns: 80, rows: 24 };

const tty = (stream: Partial<NodeJS.WriteStream>, input?: Partial<NodeJS.ReadStream>) => ({
  stream: stream as NodeJS.WriteStream,
  input: input as NodeJS.ReadStream | undefined,
});

const small: Config = {
  ...CONFIG_TEMPLATE,
  stages: [
    { name: "plan", prompt: "plan.md" },
    { name: "implement", prompt: "implement.md", gate: true },
  ],
};

test("everything is ticked to begin with: the question is what to leave out", () => {
  const state = picker(small);
  assert.deepEqual(chosen(state), ["plan", "implement", "pull-request"]);
  assert.equal(state.at, 0, "and the cursor starts on the bulk row, which is the first row there is");
});

test("space ticks the row the operator is on, and nothing else", () => {
  const state = press("toggle", press("down", press("down", picker(small))));
  assert.deepEqual(chosen(state), ["plan", "pull-request"], "two rows down from the bulk row is the second step");
});

test("the bulk row clears the list when it is full, and fills it when it is not", () => {
  const cleared = press("toggle", picker(small));
  assert.deepEqual(chosen(cleared), []);
  assert.deepEqual(chosen(press("toggle", cleared)), ["plan", "implement", "pull-request"]);
  assert.equal(bulk(picker(small)).title, "Select None (3/3)", "it says what it would do, not what is true");
  assert.equal(bulk(cleared).title, "Select All (0/3)");
});

test("the answer is the run's order, not the order the rows were ticked in", () => {
  const none = press("none", picker(small));
  const backwards = press("toggle", press("up", press("toggle", press("down", press("down", press("down", none))))));
  assert.deepEqual(chosen(backwards), ["implement", "pull-request"], "picked last first, answered in order");
});



test("the cursor stops at both ends rather than coming back around", () => {
  assert.equal(press("up", press("up", picker(small))).at, 0);
  const bottom = [1, 2, 3, 4, 5].reduce((state) => press("down", state), picker(small));
  assert.equal(bottom.at, 3, "the bulk row and three steps, so the last one is index three");
});

test("confirm and cancel are the driver's to read: they leave the picker alone", () => {
  const state = press("down", picker(small));
  assert.deepEqual(press("confirm", state), state);
  assert.deepEqual(press("cancel", state), state);
  assert.deepEqual(press("unknown", state), state);
});

test("space and enter are two keys here, where the screen folds with either", () => {
  assert.deepEqual(decode(" "), ["toggle"]);
  assert.deepEqual(decode("an"), ["unknown", "unknown"], "all and none are the bulk row's, not a key nobody can see");
  assert.deepEqual(decode("\r"), ["confirm"]);
  assert.deepEqual(decode("\x1b[B\x1b[A"), ["down", "up"]);
  assert.deepEqual(decode("jk"), ["down", "up"]);
  assert.deepEqual(decode("\x03"), ["cancel"]);
  assert.deepEqual(
    decode("\x1b"),
    ["unknown"],
    "a lone Esc means nothing: an arrow split across two chunks must not end a run that has not started",
  );
});

test("the question is a step in a flow, drawn down a rail from the chip to the description", () => {
  assert.deepEqual(lines(picker(small), SIZE, plain), [
    "┌  fabrika ",
    "│ ",
    "◇ 3 steps in .fabrika/config.json",
    "│ ",
    "◆ Steps to run",
    "│ ↑↓ move, space select, enter confirm",
    "│ ",
    "│ ) ● Select None (3/3)",
    "│   ───────────────────",
    "│   ● Plan",
    "│   ● Implement",
    "│   ● Pull request",
    "│ ",
    "│ Description",
    "│ Clear all 3 steps.",
  ]);
});

test("an unticked step is hollow, and the description follows wherever the operator stands", () => {
  const drawn = lines(press("toggle", press("down", picker(small))), SIZE, plain);
  assert.equal(drawn[9], "│ ) ○ Plan");
  assert.equal(drawn[7], "│   ○ Select All (2/3)", "the bulk row wears the mark of the list it would act on");
  assert.equal(drawn.at(-1), "│ One agent session on plan.md.");
});

test("the description of a gated stage says the gate is part of it", () => {
  const drawn = lines(press("down", press("down", picker(small))), SIZE, plain);
  assert.equal(drawn.at(-1), "│ One agent session on implement.md, then your gate until it passes.");
});

test("more rows than the terminal has room for scroll, and say how many are out of sight", () => {
  const many: Picker = {
    rows: Array.from({ length: 12 }, (_, index) => ({
      name: `s${index}`,
      title: `Stage ${index}`,
      about: "agent",
      description: `Stage ${index}.`,
    })),
    on: Array.from({ length: 12 }, () => true),
    at: 12,
  };
  const drawn = lines(many, { columns: 80, rows: 18 }, plain);
  assert.ok(drawn.length <= 18, `the block is never taller than the terminal: ${drawn.length} lines`);
  assert.ok(drawn.some((line) => line.startsWith("│     ↑ ")), drawn.join("\n"));
  assert.ok(drawn.some((line) => line.includes("Stage 11")), "the row the operator is on is always drawn");
  assert.ok(!drawn.some((line) => line.includes("Select None")), "the bulk row scrolls away like any other");
  assert.ok(!drawn.some((line) => line.includes("──")), "and its rule goes with it, having nothing left to separate");
});

test("a row is cut to the terminal, never wrapped: one line has to stay one row", () => {
  const drawn = lines(picker(small), { columns: 20, rows: 24 }, plain);
  for (const line of drawn) assert.ok(line.length <= 19, `${line.length} columns: ${line}`);
});

/** What the terminal is actually handed: the styler marks its own output, so a scrubbed escape is visible here. */
const marking = (style: Style, text: string) => `<${String(style)}>${text}</>`;

test("the dressing survives to the terminal: the chip, the diamonds, and the row the operator is on", () => {
  const drawn = lines(press("down", picker(small)), { columns: 80, rows: 24 }, marking);

  assert.equal(drawn[0], "<dim>┌ </><inverse,cyan> fabrika </>");
  assert.equal(drawn[2], "<green>◇ </>3 steps in .fabrika/config.json");
  assert.equal(drawn[4], "<bold,green>◆ </><bold>Steps to run</>");
  assert.equal(drawn[9], "<dim>│ </><cyan>) </><green>● </><underline,cyan>Plan</>");
  assert.equal(drawn[10], "<dim>│ </>  <green>● </>Implement", "a row the cursor is not on is underlined by nothing");
  assert.equal(drawn.at(-2), "<dim>│ Description</>");
});

test("an unticked row is hollow and dim, wherever the cursor is", () => {
  const drawn = lines(press("toggle", press("down", picker(small))), { columns: 80, rows: 24 }, marking);
  assert.equal(drawn[9], "<dim>│ </><cyan>) </><dim>○ </><underline,cyan>Plan</>");
});

test("a narrow terminal cuts the text and keeps every tag whole", () => {
  const drawn = lines(picker(small), { columns: 16, rows: 24 }, marking);

  assert.equal(drawn[9], "<dim>│ </>  <green>● </>Plan", "what fits is still dressed as itself");
  for (const line of drawn) {
    const text = line.replace(/<[^>]*>/g, "");
    assert.ok(text.length <= 15, `${text.length} columns of text: ${line}`);
    assert.equal(line.split("<").length, line.split(">").length, `a tag was cut in half: ${line}`);
  }
});

test("what the answer leaves behind is one row that closes the rail", () => {
  assert.equal(settled(["spec", "implement"], marking), "<green>◇ </>steps: spec · implement");
  assert.match(settled([], plain), /^◇ steps: none — the worktree and nothing else$/);
  assert.equal(abandoned(plain), "■ cancelled");
});

test("a surface with no keyboard is never asked, however dressed its output is", () => {
  // `canAnswer` reads the console's own verdict, and that verdict reads the
  // environment — so this test states the keyboard half on an environment it
  // owns rather than on whatever the machine running it happens to export.
  // Left ambient, the first assertion is a fact about the shell: it holds on
  // a developer's terminal and fails under `CI=true`, which is every run of
  // this suite on a runner.
  const saved = { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM, CI: process.env.CI };
  try {
    delete process.env.NO_COLOR;
    delete process.env.CI;
    process.env.TERM = "xterm-256color";

    assert.equal(canAnswer(tty({ isTTY: true }, { isTTY: true })), true);
    assert.equal(canAnswer(tty({ isTTY: true }, { isTTY: false })), false, "a TTY stdout with a piped stdin cannot answer");
    assert.equal(canAnswer(tty({ isTTY: true }, undefined)), false);
    assert.equal(canAnswer(tty({ isTTY: false }, { isTTY: true })), false, "and a pipe is not asked either");

    process.env.CI = "true";
    assert.equal(canAnswer(tty({ isTTY: true }, { isTTY: true })), false, "and a veto on the console closes the question too");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
