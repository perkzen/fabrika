import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CONFIG_TEMPLATE } from "../src/config.ts";

/**
 * The CLI's own flag parsing, which no port can see.
 *
 * `fabrika sync` is the form the README documents and the one a schedule
 * invokes; `--dry-run` is the thing you opt into. Whether the parser agrees is
 * not observable above `cli.ts`, and the composition root behind it is
 * untested by design — so this spawns the CLI and reads what it says.
 *
 * It runs in an empty directory on purpose: the command reaches the missing
 * config and stops, which is past the parser and short of git, GitHub and the
 * agent.
 */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const cli = (...args: ReadonlyArray<string>) => {
  const cwd = mkdtempSync(join(tmpdir(), "fabrika-cli-"));
  try {
    execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return "";
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
};

const sync = (...args: ReadonlyArray<string>) => cli("sync", ...args);

test("`fabrika sync` runs without --dry-run, which is a flag you opt into", () => {
  const out = sync();

  assert.doesNotMatch(out, /Missing required flag/, `the parser rejected the command's primary form:\n${out}`);
  assert.match(out, /ConfigNotFound/, `it got as far as the missing config, which is where an empty directory stops:\n${out}`);
});

test("`fabrika sync --dry-run` parses too", () => {
  assert.doesNotMatch(sync("--dry-run"), /Missing required flag/);
});

test("--concurrency below 1 is a CLI error, not a fan-out of none", () => {
  assert.match(sync("--concurrency", "0"), /--concurrency must be at least 1/);
});

test("`fabrika run` takes a spec file and nothing else: Linear reaches a run through MCP, not an API key", () => {
  const out = cli("run");

  assert.match(out, /--file/, `the one input a run has is the one the parser asks for:\n${out}`);
  assert.doesNotMatch(out, /LINEAR_API_KEY/, "fabrika holds no Linear credential to be missing");
});

/**
 * A directory a `run` can get past the config into: the shipped template, and
 * a ticket file. `PATH` keeps `node` and drops everything else, so the auth
 * probe — the first thing after the steps are settled — cannot find `claude`
 * and the run stops there. That failure is the marker: reaching it means the
 * command asked nothing and spawned no agent.
 */
const repo = () => {
  const cwd = mkdtempSync(join(tmpdir(), "fabrika-cli-run-"));
  mkdirSync(join(cwd, ".fabrika"));
  writeFileSync(join(cwd, ".fabrika", "config.json"), JSON.stringify(CONFIG_TEMPLATE, null, 2));
  writeFileSync(join(cwd, "t.md"), "---\nid: T-1\ntype: feat\n---\n\n# A ticket\n\nbody\n");
  return cwd;
};

const run = (cwd: string, ...args: ReadonlyArray<string>) => {
  try {
    execFileSync(process.execPath, [CLI, "run", "--file", "t.md", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: dirname(process.execPath) },
    });
    return "";
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
};

test("--steps names the steps to run, and a name that is nothing here is a CLI error", () => {
  const out = run(repo(), "--steps", "refacter");

  assert.match(out, /--steps: no step called refacter/, `the typo was accepted:\n${out}`);
  assert.match(out, /this repo runs spec, plan, implement, refactor, security, review, pull-request/, out);
  assert.doesNotMatch(out, /claude/, "a selection that cannot be run must not reach the auth probe");
});

test("--steps that name real steps is taken as the answer, with no question asked", () => {
  const out = run(repo(), "--steps", "implement,pull-request");

  assert.doesNotMatch(out, /--steps:/, `a valid list was rejected:\n${out}`);
  assert.match(out, /claude/, `it should reach the auth probe, which is the first thing after the steps are settled:\n${out}`);
});

/**
 * The property a scheduled `fabrika run` depends on: a surface that cannot
 * answer a question is never asked one. Here stdout is a pipe and stdin is
 * `/dev/null`, so the select is skipped and the whole pipeline is what runs —
 * which the auth probe, reached with nothing typed, is the proof of.
 */
test("no --steps and nobody watching runs every step rather than stopping on a question", () => {
  const out = run(repo());

  assert.doesNotMatch(out, /Steps to run/, `the select rendered into a pipe:\n${out}`);
  assert.match(out, /claude/, `the command stopped before the auth probe:\n${out}`);
});
