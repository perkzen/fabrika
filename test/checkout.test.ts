import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import * as gitWorkspace from "../src/adapters/git-workspace.ts";
import { FabrikaError } from "../src/errors.ts";
import { Workspace } from "../src/ports/workspace.ts";

/**
 * ADR-0004's `reset --hard`, against a real git repository.
 *
 * The only test in this suite that spawns git, and it is here because what it
 * pins is not observable above the adapter: the reset is the most destructive
 * thing a sweep does, and whether it can reach a tree fabrika did not just
 * create is a question about git, not about the ports.
 */
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A bare origin, a clone, and `feature` pushed but not checked out anywhere. */
const repository = () => {
  const root = mkdtempSync(join(tmpdir(), "fabrika-checkout-"));
  const origin = join(root, "origin.git");
  const repoRoot = join(root, "repo");
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "clone", origin, repoRoot);
  writeFileSync(join(repoRoot, "README.md"), "one\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-m", "one");
  git(repoRoot, "push", "-u", "origin", "main");
  git(repoRoot, "checkout", "-b", "feature");
  writeFileSync(join(repoRoot, "feature.txt"), "the remote tip\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-m", "two");
  git(repoRoot, "push", "-u", "origin", "feature");
  // Off the branch and the local ref gone: the state a sweep finds a pull
  // request in, and what lets `select` hand this one to a worker at all.
  git(repoRoot, "checkout", "main");
  git(repoRoot, "branch", "-D", "feature");
  return { repoRoot, dir: join(root, "worktrees", "FAB-9-42") };
};

const checking = (where: ReturnType<typeof repository>, branch: string) =>
  Effect.gen(function* () {
    return yield* (yield* Workspace).checkout(branch);
  }).pipe(
    Effect.provide(gitWorkspace.layer({ repoRoot: where.repoRoot, dir: where.dir, base: "origin/main" })),
    Effect.provide(NodeServices.layer),
  );

const checkout = (where: ReturnType<typeof repository>, branch: string) => Effect.runPromise(checking(where, branch));

test("a sweep's tree is created on the branch as the remote has it", async () => {
  const where = repository();

  await checkout(where, "feature");

  assert.equal(readFileSync(join(where.dir, "feature.txt"), "utf8"), "the remote tip\n");
});

test("a tree that is already there is refused, not reset over", async () => {
  const where = repository();
  await checkout(where, "feature");
  // What the other sweep's agent is in the middle of: a resolved conflict it
  // has not committed yet. A `reset --hard` here is that work gone.
  writeFileSync(join(where.dir, "feature.txt"), "a merge in progress\n");

  const error = await Effect.runPromise(Effect.flip(checking(where, "feature")));

  assert.ok(error instanceof FabrikaError, `refused with the error the ports speak, not a crash: ${error}`);
  assert.match(error.message, /FAB-9-42/, "the line names the tree, because cleaning it up is the operator's next move");
  assert.equal(
    readFileSync(join(where.dir, "feature.txt"), "utf8"),
    "a merge in progress\n",
    "the selection rule reads `git worktree list` once, so a tree that appeared since is another sweep's",
  );
  assert.ok(existsSync(join(where.dir, ".git")));
});
