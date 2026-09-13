import assert from "node:assert/strict";
import { test } from "node:test";
import { editorOpener } from "../src/infra/editor.ts";

/** The spawn, recorded rather than taken, so this file never launches an editor. */
const spawned = () => {
  const calls: Array<[string, ReadonlyArray<string>]> = [];
  const envs: Array<NodeJS.ProcessEnv> = [];
  return {
    calls,
    envs,
    spawn: (bin: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => {
      calls.push([bin, args]);
      envs.push(env);
    },
  };
};

test("FABRIKA_EDITOR is the command, and the worktree is its last argument", () => {
  const { calls, spawn } = spawned();
  const open = editorOpener("/abs/FAB-7", { FABRIKA_EDITOR: "open -a WebStorm" }, "darwin", spawn);
  assert.deepEqual(calls, [], "nothing is spawned by having the key, only by pressing it");

  open?.();
  assert.deepEqual(
    calls,
    [["open", ["-a", "WebStorm", "/abs/FAB-7"]]],
    "a command with arguments is argv, and the path is one entry of it — never a string handed to a shell",
  );
});

test("a one-word command takes the worktree as its only argument", () => {
  const { calls, spawn } = spawned();
  editorOpener("/abs/FAB-7", { FABRIKA_EDITOR: "code" }, "darwin", spawn)?.();
  assert.deepEqual(calls, [["code", ["/abs/FAB-7"]]]);
});

test("macOS answers for itself when the operator has not, and nothing else does", () => {
  const { calls, spawn } = spawned();
  editorOpener("/abs/FAB-7", {}, "darwin", spawn)?.();
  editorOpener("/abs/FAB-7", { FABRIKA_EDITOR: "   " }, "darwin", spawn)?.();
  assert.deepEqual(
    calls,
    [
      ["open", ["/abs/FAB-7"]],
      ["open", ["/abs/FAB-7"]],
    ],
    "the machine already knows what opens a directory, and a blank variable is an unset one",
  );

  assert.equal(
    editorOpener("/abs/FAB-7", {}, "linux", spawn),
    undefined,
    "elsewhere there is no default worth guessing, so there is no opener and so no key",
  );
});

test("the platform decides the fallback and nothing else, so a named editor works anywhere", () => {
  const { calls, spawn } = spawned();
  editorOpener("/abs/FAB-7", { FABRIKA_EDITOR: "code" }, "linux", spawn)?.();
  assert.deepEqual(calls, [["code", ["/abs/FAB-7"]]]);
});

test("the editor is handed an environment with no credentials in it", () => {
  const { envs, spawn } = spawned();
  editorOpener(
    "/abs/FAB-7",
    {
      FABRIKA_EDITOR: "code",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      LINEAR_API_KEY: "lin_api_secret",
      ANTHROPIC_AUTH_TOKEN: "sk-secret",
      GH_TOKEN: "ghp_secret",
    },
    "linux",
    spawn,
  )?.();

  assert.deepEqual(
    envs,
    [{ FABRIKA_EDITOR: "code", PATH: "/usr/bin", SSH_AUTH_SOCK: "/tmp/agent.sock" }],
    "an editor is a long-lived process the operator works inside, and fabrika's keys are not its to hold — but the ssh agent is the operator's own, and a terminal in there still has to push",
  );
});
