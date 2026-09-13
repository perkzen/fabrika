import assert from "node:assert/strict";
import { test } from "node:test";
import { nameBranch } from "../src/pipeline/steps/branch.ts";
import { exercise } from "./harness.ts";

const named = { text: "", structured: { type: "feat", slug: "export-button", preview: false } };

test("the naming call's answer becomes the branch and the type the stages see", async () => {
  const { recording } = await exercise(nameBranch.run, { worktreeExists: false, agent: () => named });
  assert.equal(recording.state().branch, "domen-perko/feat/FAB-1/export-button");
  assert.equal(recording.state().type, "feat", "the call reads the ticket more carefully than a label regex");
});

/** The naming call is not a configured stage, so it takes the top-level model and nothing finer (ADR-0005). */
test("the naming call names no model of its own", async () => {
  const { recording } = await exercise(nameBranch.run, { worktreeExists: false, agent: () => named });
  assert.deepEqual(recording.agent.map((call) => call.model), [undefined]);
});
