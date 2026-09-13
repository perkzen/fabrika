import assert from "node:assert/strict";
import { test } from "node:test";
import { editorCommand } from "../src/infra/editor.ts";

test("FABRIKA_EDITOR is the command, split on whitespace into argv", () => {
  assert.deepEqual(editorCommand({ FABRIKA_EDITOR: "code" }, "darwin"), ["code"]);
  assert.deepEqual(
    editorCommand({ FABRIKA_EDITOR: "open -a WebStorm" }, "darwin"),
    ["open", "-a", "WebStorm"],
    "a command with arguments is argv, never a string handed to a shell",
  );
});

test("macOS answers for itself when the operator has not, and nothing else does", () => {
  assert.deepEqual(editorCommand({}, "darwin"), ["open"], "the machine already knows what opens a directory");
  assert.deepEqual(editorCommand({ FABRIKA_EDITOR: "   " }, "darwin"), ["open"], "a blank variable is an unset one");
  assert.equal(editorCommand({}, "linux"), undefined, "elsewhere there is no default worth guessing, so there is no key");
});

test("the platform decides the fallback and nothing else, so a named editor works anywhere", () => {
  assert.deepEqual(editorCommand({ FABRIKA_EDITOR: "code" }, "linux"), ["code"]);
});
