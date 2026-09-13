import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { attachesFrom, classify, createArgs } from "../src/adapters/gh-forge.ts";
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

test("keepAwake is optional, so every config written before it still loads", async () => {
  const without = await Effect.runPromise(decodeConfig(JSON.stringify(CONFIG_TEMPLATE)));
  assert.equal(without.keepAwake, undefined, "and the file `init` writes does not turn one machine's preference on for everyone");

  const on = await Effect.runPromise(decodeConfig(JSON.stringify({ ...CONFIG_TEMPLATE, keepAwake: true })));
  assert.equal(on.keepAwake, true);

  const error = await Effect.runPromise(decodeConfig(JSON.stringify({ ...CONFIG_TEMPLATE, keepAwake: "yes" })).pipe(Effect.flip));
  assert.match(String(error), /\["keepAwake"\]/, "a string fails at the start of the run, not hours in");
});

test("notify is optional on the same terms", async () => {
  const without = await Effect.runPromise(decodeConfig(JSON.stringify(CONFIG_TEMPLATE)));
  assert.equal(without.notify, undefined);

  const on = await Effect.runPromise(decodeConfig(JSON.stringify({ ...CONFIG_TEMPLATE, notify: true })));
  assert.equal(on.notify, true);

  const error = await Effect.runPromise(decodeConfig(JSON.stringify({ ...CONFIG_TEMPLATE, notify: 1 })).pipe(Effect.flip));
  assert.match(String(error), /\["notify"\]/);
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
    capture: [],
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
  const config = asConfig({ base: "origin/main", install: undefined, gate: [], capture: [], provider: "none", notes: [] });
  assert.equal(config.install, undefined);
  assert.equal(JSON.parse(JSON.stringify(config)).install, undefined, "and `init` writes the file without it");
});

test("a rejected proposal writes the template untouched, so init always has a config to write", () => {
  assert.deepEqual(asConfig(null), CONFIG_TEMPLATE);
});

test("gh is asked for the right things", () => {
  // 2.93.0 is this host's; --attach arrived in 2.99.0.
  assert.equal(attachesFrom("gh version 2.93.0 (2026-08-12)\nhttps://github.com/cli/cli/releases/tag/v2.93.0"), false);
  assert.equal(attachesFrom("gh version 2.99.0 (2026-09-01)"), true);
  assert.equal(attachesFrom("gh version 3.0.1 (2026-11-02)"), true);
  assert.equal(attachesFrom(""), false, "a gh that cannot be interrogated is one that must not be handed --attach");

  assert.deepEqual(
    createArgs(
      "perkzen/fabrika",
      "main",
      { branch: "a-branch", title: "FAB-4: a thing", body: "in the file", draft: true, attachments: ["/a/one.png", "/a/two.png"] },
      "/tmp/body.md",
    ),
    [
      "pr", "create", "-R", "perkzen/fabrika",
      "--head", "a-branch",
      "--base", "main",
      "--title", "FAB-4: a thing",
      "--body-file", "/tmp/body.md",
      "--draft",
      "--attach", "/a/one.png",
      "--attach", "/a/two.png",
    ],
  );
});

test("a proposed capture is validated like a gate step", () => {
  const answer = { base: "origin/main", gate: [], provider: "none", notes: [] };

  assert.equal(asProposal({ ...answer, capture: [{ name: "x", run: "git push origin main" }] }), null, "one bad run rejects the answer");

  const proposal = asProposal({
    ...answer,
    capture: [
      { name: "Console frame", run: "node scripts/capture-console.ts", when: ["src/**"], timeoutMinutes: 4 },
      { name: "console-frame", run: "node scripts/capture-cli.ts" },
    ],
  });
  assert.deepEqual(proposal?.capture.map((capture) => capture.name), ["console-frame", "console-frame-2"]);
  assert.deepEqual(proposal?.capture[0]?.when, ["src/**"]);
  assert.equal(proposal?.capture[0]?.timeoutMinutes, 4);
  assert.equal(proposal?.capture[1]?.timeoutMinutes, undefined);

  const config = asConfig(proposal);
  assert.equal(config.pr.draft, CONFIG_TEMPLATE.pr.draft, "the template's pr fields survive a proposed capture");
  assert.equal(config.pr.emptyCommit, CONFIG_TEMPLATE.pr.emptyCommit);
  assert.deepEqual(config.pr.capture?.map((capture) => capture.name), ["console-frame", "console-frame-2"]);

  assert.equal(asConfig(asProposal(answer)).pr.capture, undefined, "a repo with nothing to capture gets no key at all");
});

test("a capture name is a plain label, because the host makes a directory out of it and then empties it", async () => {
  const withCapture = (name: string) =>
    JSON.stringify({ ...CONFIG_TEMPLATE, pr: { ...CONFIG_TEMPLATE.pr, capture: [{ name, run: "true" }] } });

  const config = await Effect.runPromise(decodeConfig(withCapture("console-frame-2")));
  assert.equal(config.pr.capture?.[0]?.name, "console-frame-2", "what `configure` proposes still decodes");

  // `~/.fabrika/captures/<repo>/<sha>/<name>` is removed and remade every run;
  // a name that climbs out of it takes the recursive delete with it.
  const error = await Effect.runPromise(decodeConfig(withCapture("../../../..")).pipe(Effect.flip));
  assert.match(String(error), /\["pr"\]\["capture"\]\[0\]\["name"\]/, "and says which capture is wrong");

  for (const name of ["with space", "Caps", "back`tick", "pipe|d", ""]) {
    await Effect.runPromise(decodeConfig(withCapture(name)).pipe(Effect.flip));
  }
});

test("every name a proposal can produce is one the config can be loaded with", async () => {
  // `init` writes what `asConfig` returns and `run` decodes it back, so a
  // name the normaliser emits and the schema rejects is a config fabrika
  // writes and then refuses to start on.
  const proposal = asProposal({
    base: "origin/main",
    gate: [],
    provider: "none",
    notes: [],
    capture: [
      { name: `${"x".repeat(39)} frame`, run: "true" },
      { name: "Console   frame", run: "true" },
      { name: "!!!", run: "true" },
    ],
  });

  const config = await Effect.runPromise(decodeConfig(JSON.stringify(asConfig(proposal))));
  assert.deepEqual(config.pr.capture?.map((capture) => capture.name), ["x".repeat(39), "console-frame", "check"]);
});
