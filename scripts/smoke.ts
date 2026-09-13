/**
 * Proves the things the loop depends on before any loop code
 * exists: a tool call executes, a deny rule holds under
 * --dangerously-skip-permissions, --resume carries context across
 * directories, --json-schema returns parseable output, and fabrika's own
 * skills load through --plugin-dir on fresh and resumed sessions. Linear MCP
 * is checked only when `linear-ro` is registered.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Data, Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../src/infra/claude.ts";
import { allServers, mcpConfigFile, resolveServers } from "../src/infra/mcp.ts";

// Where `fabrika init` will run. Local-scope servers are keyed to this exact
// path; user-scope ones (`claude mcp add -s user`) apply regardless.
const repo = "/Users/domen/dev/parakeetai/parakeetai-monorepo";

// A plain `Error` here would collapse the typed error union (ClaudeAuthError
// extends Error), hiding the tag from catchTag below.
class SmokeFailed extends Data.TaggedError("SmokeFailed")<{}> {}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = mkdtempSync(join(tmpdir(), "fabrika-smoke-"));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* spawner.exitCode(
    ChildProcess.make("sh", ["-c", "git init -q && git commit -q --allow-empty -m init"], {
      cwd,
      extendEnv: true,
    }),
  );
  const rawLog = join(cwd, "raw.jsonl");
  const credential = { name: "default", env: {} };
  const results: Array<boolean> = [];
  const check = (name: string, ok: boolean, detail = "") =>
    Effect.sync(() => {
      results.push(ok);
      console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    });

  yield* Console.log(`scratch: ${cwd}`);

  // A: Bash executes; deny rule holds.
  const a = yield* runClaude({
    cwd,
    credential,
    rawLog,
    disallowedTools: ["Bash(git push:*)"],
    prompt:
      "Two steps. 1) Use Bash to run `echo fabrika-smoke-ok` and report the exact output. " +
      "2) Use Bash to run `git push origin main`. Report verbatim what the tool returned for step 2, then stop.",
  });
  yield* check("bash tool call executed", a.text.includes("fabrika-smoke-ok"));
  yield* check("session_id captured", !!a.sessionId, a.sessionId ?? "");
  // Read off the init event, not the model's say-so: the stage prompts name
  // `fabrika:<skill>` and a missing plugin would fail silently otherwise.
  yield* check("--plugin-dir loads fabrika skills", a.loadedSkills.includes("fabrika:tdd"), a.loadedSkills.filter((s) => s.startsWith("fabrika:")).join(","));

  const events = (yield* fs.readFileString(rawLog))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type?: string; message?: { content?: unknown } });
  const pushResult = events
    .filter((e) => e.type === "user")
    .flatMap((e) => (e.message?.content as Array<{ type?: string; content?: unknown }>) ?? [])
    .filter((b) => b.type === "tool_result")
    .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)))
    .find((c) => /push|denied|permission|blocked|not allowed/i.test(c));
  const denied = !!pushResult && /denied|permission|blocked|not allowed|disallowed/i.test(pushResult);
  yield* check(
    "deny rule survives --dangerously-skip-permissions",
    denied,
    (pushResult ?? "no tool_result seen").slice(0, 200),
  );

  // B: --resume carries context — from a *different* cwd. The loop resumes the
  // same session from the worktree and from outside it.
  const elsewhere = mkdtempSync(join(tmpdir(), "fabrika-smoke-elsewhere-"));
  const b = yield* runClaude({
    cwd: elsewhere,
    credential,
    rawLog,
    resume: a.sessionId,
    prompt: "What exact string did the echo command print earlier in this conversation? Reply with only that string.",
  });
  yield* check("--resume carries context across directories", b.text.includes("fabrika-smoke-ok"), b.text.slice(0, 80));
  yield* check("--plugin-dir loads on a resumed session", b.loadedSkills.includes("fabrika:tdd"));

  // C: --json-schema with stream-json, and --model on the same call — the only
  // place the real binary is asked to accept the flag. An alias rather than a
  // full name: `--help` lists the aliases and they outlive releases.
  const c = yield* runClaude({
    cwd,
    credential,
    rawLog,
    model: "sonnet",
    jsonSchema: JSON.stringify({
      type: "object",
      properties: { ok: { type: "boolean" }, name: { type: "string" } },
      required: ["ok", "name"],
    }),
    prompt: "Return ok=true and name='fabrika'.",
  });
  const structured = c.structured as { ok?: boolean; name?: string } | undefined;
  yield* check(
    "--json-schema returns structured_output on a call that also sets --model",
    structured?.ok === true && structured?.name === "fabrika",
    JSON.stringify(c.structured ?? c.text.slice(0, 120)),
  );

  // D: Linear MCP with a bearer header, only if registered. The scoped temp
  // file is removed when this block ends.
  const servers = yield* allServers(repo);
  if (servers["linear-ro"]) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* mcpConfigFile(yield* resolveServers(repo, ["linear-ro"]));
        const d = yield* runClaude({
          cwd,
          credential,
          rawLog,
          mcpConfigFile: file,
          prompt: "Use the Linear MCP tools to fetch the title of issue PAR-565 and reply with only the title.",
        });
        yield* check("linear MCP via bearer header", d.text.length > 0 && !/unable|cannot|no tool/i.test(d.text), d.text.slice(0, 120));
      }),
    );
  } else {
    yield* Console.log("SKIP linear MCP — register `linear-ro` first: claude mcp add -s user … (docs/internals.md §MCP servers and Linear)");
  }

  yield* Console.log(`\nraw log: ${rawLog}`);
  if (results.some((ok) => !ok)) return yield* new SmokeFailed();
});

program.pipe(
  Effect.catchTag("AgentUnauthorized", (e) =>
    Console.error(`claude cannot authenticate (${e.message.slice(0, 120)}) — run \`claude auth login\` in a terminal`).pipe(
      Effect.andThen(Effect.fail(e)),
    ),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
