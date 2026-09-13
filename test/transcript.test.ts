import assert from "node:assert/strict";
import { test } from "node:test";
import { describeContent, describeToolUse } from "../src/infra/transcript.ts";

const CWD = "/Users/domen/.fabrika/worktrees/fabrika/FAB-1";

/** One row per tool the agent actually reaches for, with the subject written out by hand. */
const table: ReadonlyArray<[string, Record<string, unknown>, string]> = [
  ["Bash", { command: "pnpm test", description: "Run the test suite" }, "Run the test suite"],
  ["Bash", { command: "git status --short" }, "git status --short"],
  ["Read", { file_path: `${CWD}/src/cli.ts` }, "src/cli.ts"],
  ["Write", { file_path: `${CWD}/src/infra/console.ts` }, "src/infra/console.ts"],
  ["Edit", { file_path: `${CWD}/test/harness.ts` }, "test/harness.ts"],
  ["NotebookEdit", { file_path: `${CWD}/notes.ipynb` }, "notes.ipynb"],
  ["Glob", { pattern: "**/*.test.ts" }, "**/*.test.ts"],
  ["Grep", { pattern: "journal.log", path: "src" }, "journal.log in src"],
  ["Task", { description: "find the gate adapter" }, "find the gate adapter"],
  ["Agent", { description: "review the diff" }, "review the diff"],
  ["WebFetch", { url: "https://effect.website/docs" }, "https://effect.website/docs"],
  ["WebSearch", { query: "effect 4 layer finalizer" }, "effect 4 layer finalizer"],
  ["Skill", { skill: "fabrika:tdd" }, "fabrika:tdd"],
  ["TodoWrite", { todos: [{}, {}, {}] }, "3 todos"],
  ["mcp__linear__list_issues", { teamId: "FAB" }, "linear/list_issues"],
  ["SomeToolWeHaveNeverSeen", { anything: "at all" }, ""],
  ["Read", {}, ""],
];

for (const [tool, input, expected] of table) {
  test(`${tool} is described by ${expected || "its name alone"}`, () => {
    assert.equal(describeToolUse(tool, input, CWD), expected);
  });
}

test("a multi-line Bash command with no description gives up after its first line", () => {
  const command = ["set -euo pipefail", "for f in $(git ls-files); do", "  echo $f", "done", "x".repeat(3000)].join("\n");
  assert.equal(describeToolUse("Bash", { command }, CWD), "set -euo pipefail");
});

test("every subject is one line and no longer than 120 characters, whatever it came from", () => {
  const long = describeToolUse("Task", { description: "a ".repeat(200) }, CWD);
  assert.equal(long.length, 120);
  assert.doesNotMatch(long, /\n/);

  assert.equal(describeToolUse("Bash", { description: "first\nsecond   third" }, CWD), "first second third");
});

test("an assistant message says its piece, then names the tools it reached for, in order", () => {
  assert.deepEqual(
    describeContent(
      [
        { type: "text", text: "I'll read the gate adapter " },
        { type: "text", text: "and the port behind it." },
        { type: "tool_use", name: "Read", input: { file_path: `${CWD}/src/adapters/shell-gate.ts` } },
        { type: "tool_use", name: "Bash", input: { command: "pnpm test", description: "Run the suite" } },
      ],
      "implement",
      CWD,
    ),
    [
      { kind: "agent", stage: "implement", markdown: "I'll read the gate adapter and the port behind it." },
      { kind: "tool", stage: "implement", tool: "Read", subject: "src/adapters/shell-gate.ts" },
      { kind: "tool", stage: "implement", tool: "Bash", subject: "Run the suite" },
    ],
    "the order the operator would have seen",
  );
});

test("a message that is only tool calls says nothing before them", () => {
  assert.deepEqual(
    describeContent([{ type: "tool_use", name: "Skill", input: { skill: "fabrika:tdd" } }], "plan", CWD),
    [{ kind: "tool", stage: "plan", tool: "Skill", subject: "fabrika:tdd" }],
  );
});

test("the json-schema delivery mechanism stays off the screen", () => {
  assert.deepEqual(describeContent([{ type: "tool_use", name: "StructuredOutput", input: {} }], "review", CWD), []);
});
