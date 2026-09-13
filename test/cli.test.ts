import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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

const sync = (...args: ReadonlyArray<string>) => {
  const cwd = mkdtempSync(join(tmpdir(), "fabrika-cli-"));
  try {
    execFileSync("node", [CLI, "sync", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return "";
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
};

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
