import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodePath } from "@effect/platform-node";
import { Effect, Path } from "effect";
import { classify, mergeStateOf } from "../src/adapters/gh-forge.ts";
import { parseScore } from "../src/adapters/cubic-reviewer.ts";
import { baseBranch, CONFIG_TEMPLATE, decodeConfig, remoteOf } from "../src/config.ts";
import { home } from "../src/paths.ts";
import { asConfig, asProposal } from "../src/configure.ts";
import { asBranchParts, branchName, slug, type Ticket } from "../src/ticket.ts";

const ticket: Ticket = { identifier: "PAR-12", title: "Add a new export button", description: "", type: "feat" };

test("a slug drops filler and stays short", () => {
  assert.equal(slug("Add a new export button"), "export-button");
  assert.equal(slug("!!!"), "ticket");
});

test("a branch fills the pattern and prefixes only a preview change", () => {
  const parts = { type: "fix", slug: "export-button", preview: true } as const;
  assert.equal(
    branchName("{user}/{type}/{ticket}/{slug}", ticket, parts, "preview/", "domen-perko"),
    "preview/domen-perko/fix/PAR-12/export-button",
  );
  assert.equal(
    branchName("{user}/{type}/{ticket}/{slug}", ticket, { ...parts, preview: false }, "preview/", "domen-perko"),
    "domen-perko/fix/PAR-12/export-button",
  );
});

test("a naming answer that breaks the rules is rejected, so the deterministic parts stand in", () => {
  assert.deepEqual(asBranchParts({ type: "feat", slug: "export-button", preview: true }), {
    type: "feat",
    slug: "export-button",
    preview: true,
  });
  assert.equal(asBranchParts({ type: "feature", slug: "x", preview: true }), null, "unknown type");
  assert.equal(asBranchParts({ type: "feat", slug: "Export Button", preview: true }), null, "not kebab-case");
  assert.equal(asBranchParts({ type: "feat", slug: "x", preview: "yes" }), null, "preview is not a boolean");
  assert.equal(asBranchParts(undefined), null);
});

test("a gate step that would launder a denied tool back in rejects the whole proposal", () => {
  const base = { base: "origin/main", gate: [{ name: "compile", run: "tsc" }], notes: [] };
  assert.ok(asProposal(base));
  for (const run of ["git push origin main", "gh pr merge 3", "npm publish", "rm -rf /"]) {
    assert.equal(asProposal({ ...base, gate: [{ name: "x", run }] }), null, run);
  }
  assert.equal(asProposal({ ...base, install: "git push" }), null, "nor through the install command");
});

test("a proposal is normalised where it can be and rejected where it cannot", () => {
  const proposal = asProposal({
    base: "main",
    gate: [{ name: "Typecheck", run: "tsc" }, { name: "e2e (chromium)", run: "playwright test" }],
    notes: ["read from ci.yml"],
  });
  assert.equal(proposal?.base, "origin/main", "a bare branch name gets the remote it must have had");
  assert.deepEqual(proposal?.gate.map((step) => step.name), ["typecheck", "e2e-chromium"]);
  assert.equal(asProposal({ base: "", gate: [], notes: [] }), null);
});

test("a check rollup is bucketed, and the reviewer's own check is not waited on", () => {
  const checks = classify(
    [
      { __typename: "CheckRun", name: "test", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/9/job/8" },
      { __typename: "CheckRun", name: "lint", workflowName: "CI", status: "IN_PROGRESS", conclusion: "", detailsUrl: "https://example.test" },
      { __typename: "StatusContext", context: "vercel", state: "SUCCESS", targetUrl: "https://vercel.test" },
      { __typename: "StatusContext", context: "cubic review", state: "PENDING", targetUrl: "https://cubic.dev/x" },
    ],
    (name, url) => /cubic/i.test(name) || url.includes("cubic.dev"),
  );
  assert.deepEqual(
    checks.map((check) => [check.name, check.state]),
    [["CI / test", "fail"], ["CI / lint", "pending"], ["vercel", "pass"]],
  );
  assert.deepEqual(checks[0]!.job, { repo: "o/r", id: "9", jobId: "8" }, "a rerunnable job is recognised by its URL");
});

test("a missing score is never a pass", () => {
  assert.equal(parseScore("<!-- cubic:review-summary:confidence-score:4/5 -->"), 4);
  assert.equal(parseScore("no score here"), null);
});

test("both providers decode and a third does not, so a typo fails at the start of the run", async () => {
  const withProvider = (provider: string) =>
    JSON.stringify({ ...CONFIG_TEMPLATE, review: { ...CONFIG_TEMPLATE.review, provider } });

  for (const provider of ["cubic", "none"]) {
    const config = await Effect.runPromise(decodeConfig(withProvider(provider)));
    assert.equal(config.review.provider, provider);
  }
  const error = await Effect.runPromise(decodeConfig(withProvider("cubik")).pipe(Effect.flip));
  assert.match(String(error), /Expected "cubic" \| "none"/, "and says which field and which values");
  assert.match(String(error), /\["review"\]\["provider"\]/);
});

test("the config init falls back to is runnable on a repo with no review bot", async () => {
  const config = await Effect.runPromise(decodeConfig(JSON.stringify(CONFIG_TEMPLATE)));
  assert.equal(config.review.provider, "none", "a fallback that assumed a bot would escalate by construction");
});

test("a proposal keeps cubic and normalises anything else to none, without losing the rest of it", () => {
  const base = { base: "origin/main", gate: [{ name: "compile", run: "tsc" }], notes: [] };
  assert.equal(asProposal({ ...base, provider: "cubic" })?.provider, "cubic");
  for (const provider of ["none", "cubic-dev-ai", "Cubic", undefined, 5, null]) {
    const proposal = asProposal({ ...base, provider });
    assert.equal(proposal?.provider, "none", String(provider));
    assert.deepEqual(proposal?.gate, [{ name: "compile", run: "tsc" }], "a correctly-read gate survives the guess");
    assert.equal(proposal?.base, "origin/main");
  }
});

test("a proposal becomes the config init writes, and only the fields it proposed move", () => {
  const config = asConfig({
    base: "origin/trunk",
    install: "pnpm i --frozen-lockfile",
    gate: [{ name: "compile", run: "tsc" }],
    provider: "cubic",
    notes: ["read off the repo"],
  });

  assert.equal(config.base, "origin/trunk");
  assert.equal(config.install, "pnpm i --frozen-lockfile");
  assert.deepEqual(config.gate, [{ name: "compile", run: "tsc" }]);
  assert.equal(config.review.provider, "cubic");
  // The proposal names one field of `review`; the merge must not cost the other three.
  assert.equal(config.review.requireScore, CONFIG_TEMPLATE.review.requireScore);
  assert.equal(config.review.maxRounds, CONFIG_TEMPLATE.review.maxRounds);
  assert.equal(config.review.timeoutMinutes, CONFIG_TEMPLATE.review.timeoutMinutes);
  assert.deepEqual(config.stages, CONFIG_TEMPLATE.stages, "the stages are shipped, never proposed");
  assert.deepEqual(config.deny, CONFIG_TEMPLATE.deny);
});

test("a repo that needs no install step gets a config with no install key at all", () => {
  const config = asConfig({ base: "origin/main", install: undefined, gate: [], provider: "none", notes: [] });
  assert.equal(config.install, undefined);
  assert.equal(JSON.parse(JSON.stringify(config)).install, undefined, "and `init` writes the file without it");
});

test("a rejected proposal writes the template untouched, so init always has a config to write", () => {
  assert.deepEqual(asConfig(null), CONFIG_TEMPLATE);
});

test("GitHub's two merge fields map onto the four merge states", () => {
  assert.equal(mergeStateOf("CONFLICTING", "DIRTY"), "conflicted");
  assert.equal(mergeStateOf("MERGEABLE", "BEHIND"), "behind");
  assert.equal(mergeStateOf("MERGEABLE", "CLEAN"), "clean");
  assert.equal(mergeStateOf("MERGEABLE", undefined), "clean", "the expensive half of the query may be absent");
  assert.equal(mergeStateOf("UNKNOWN", "UNKNOWN"), "unknown");
  assert.equal(mergeStateOf("", ""), "unknown", "never assumed clean, never assumed conflicted");
  assert.equal(mergeStateOf("CONFLICTING", undefined), "conflicted", "only `mergeable` decides anything");
});

test("the configured base splits into the remote and the branch", () => {
  assert.equal(remoteOf("origin/main"), "origin");
  assert.equal(baseBranch("origin/main"), "main");
  assert.equal(remoteOf("main"), "origin", "a bare branch is the default remote's");
  assert.equal(baseBranch("main"), "main");
  // A branch name may carry slashes; a remote name may not, so only the
  // first segment is ever the remote.
  assert.equal(remoteOf("upstream/release/2.0"), "upstream");
  assert.equal(baseBranch("upstream/release/2.0"), "release/2.0");
});

test("a run's directory is keyed by the repository's name and the run's own key", () => {
  const path = Effect.runSync(Effect.provide(Path.Path, NodePath.layer));
  assert.equal(
    home(path, "runs", "/Users/domen/dev/fabrika", "FAB-5-42"),
    join(homedir(), ".fabrika", "runs", "fabrika", "FAB-5-42"),
  );
  assert.equal(
    home(path, "worktrees", "/Users/domen/dev/fabrika", "FAB-5-42"),
    join(homedir(), ".fabrika", "worktrees", "fabrika", "FAB-5-42"),
    "the two kinds differ only in that segment, so a tree and its log are findable from each other",
  );
  // The repository's basename, not its path: the scan for a pull request's
  // existing run directory lists this one directory and nothing above it.
  assert.equal(home(path, "runs", "/somewhere/else/fabrika", ""), home(path, "runs", "/Users/domen/dev/fabrika", ""));
});
