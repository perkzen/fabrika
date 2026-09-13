import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { classify } from "../src/adapters/gh-forge.ts";
import { parseScore } from "../src/adapters/cubic-reviewer.ts";
import { CONFIG_TEMPLATE, decodeConfig } from "../src/config.ts";
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

test("the shipped template filters refactor by what changed, and security not at all", async () => {
  const config = await Effect.runPromise(decodeConfig(JSON.stringify(CONFIG_TEMPLATE)));
  const stage = (name: string) => config.stages.find((s) => s.name === name)!;

  assert.deepEqual(stage("refactor").when, ["src/**"], "a chore that rewrites a module gets the pass");
  assert.equal(stage("refactor").only, undefined, "and a docs-only feat does not");
  assert.equal(stage("security").when, undefined, "a weakness introduced by the change is not predictable from it");
  assert.equal(stage("security").only, undefined);
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

test("source globs are normalised entry by entry, and an unusable answer falls back to the template's", () => {
  const base = { base: "origin/main", gate: [], provider: "none", notes: [] };

  assert.deepEqual(asProposal({ ...base, source: ["  lib/**  ", "packages/*/src/**"] })?.source, ["lib/**", "packages/*/src/**"]);
  assert.deepEqual(
    asProposal({ ...base, source: ["lib/**", 5, "", "   ", null, "x".repeat(201)] })?.source,
    ["lib/**"],
    "an unusable entry is dropped, not the whole answer",
  );

  for (const source of [undefined, [], ["", 5], "src/**", 7]) {
    const proposal = asProposal({ ...base, source });
    assert.deepEqual(proposal?.source, ["src/**"], String(source));
    assert.equal(proposal?.base, "origin/main", "the gate is the expensive part of this call and survives");
  }
});

test("a proposal becomes the config init writes, and only the fields it proposed move", () => {
  const config = asConfig({
    base: "origin/trunk",
    install: "pnpm i --frozen-lockfile",
    gate: [{ name: "compile", run: "tsc" }],
    provider: "cubic",
    source: ["lib/**"],
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
  // The proposed globs reach exactly one stage. Everything else about `stages`
  // is shipped, never proposed — which is what keeps `init` from having a
  // channel through which to put a `when` on `security`.
  assert.deepEqual(
    config.stages.find((stage) => stage.name === "refactor")?.when,
    ["lib/**"],
    "the one stage init gives a when",
  );
  assert.deepEqual(
    config.stages.filter((stage) => stage.name !== "refactor"),
    CONFIG_TEMPLATE.stages.filter((stage) => stage.name !== "refactor"),
    "and every other stage, security included, is the template's",
  );
  assert.deepEqual(config.deny, CONFIG_TEMPLATE.deny);
});

test("a repo that needs no install step gets a config with no install key at all", () => {
  const config = asConfig({ base: "origin/main", install: undefined, gate: [], provider: "none", source: ["src/**"], notes: [] });
  assert.equal(config.install, undefined);
  assert.equal(JSON.parse(JSON.stringify(config)).install, undefined, "and `init` writes the file without it");
});

test("a rejected proposal writes the template untouched, so init always has a config to write", () => {
  assert.deepEqual(asConfig(null), CONFIG_TEMPLATE);
});
