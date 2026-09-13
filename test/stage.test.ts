import assert from "node:assert/strict";
import { test } from "node:test";
import type { Stage } from "../src/config.ts";
import { codeStage } from "../src/pipeline/steps/stage.ts";
import { exercise } from "./harness.ts";

const implement: Stage = { name: "implement", prompt: "implement.md", system: "implement.system.md", gate: true };

test("a green gate ends the stage in one call", async () => {
  const { recording, failed } = await exercise(codeStage(implement).run, { gate: [undefined] });
  assert.equal(failed, false);
  assert.equal(recording.agent.length, 1);
  assert.equal(recording.agent[0]!.prompt, "<implement.md>");
});

test("a red gate is fed back to the same session until it goes green", async () => {
  const { recording, failed } = await exercise(codeStage(implement).run, {
    gate: [{ name: "compile", command: "tsc", output: "boom" }, undefined],
  });
  assert.equal(failed, false);
  assert.equal(recording.agent.length, 2);
  assert.equal(recording.agent[1]!.prompt, "gate compile failed", "the second call is the gate's verdict");
  assert.deepEqual(
    recording.agent.map((call) => call.session ?? call.stage),
    ["implement", "implement"],
    "the agent told to fix it is the one that wrote the code",
  );
});

test("a gate that stays red escalates rather than looping forever", async () => {
  const { exit, failed, recording } = await exercise(codeStage(implement).run, {
    gate: [{ name: "compile", command: "tsc", output: "boom" }],
    config: { maxIterations: 3 },
  });
  assert.equal(failed, true);
  assert.equal((exit as { _tag: string })._tag, "Escalated");
  assert.match((exit as { reason: string }).reason, /gate still red after 3 iterations/);
  assert.equal(recording.agent.length, 3);
});

test("an ungated stage never asks the gate", async () => {
  const { recording } = await exercise(codeStage({ name: "spec", prompt: "spec.md" }).run, {
    gate: [{ name: "compile", command: "tsc", output: "boom" }],
  });
  assert.equal(recording.agent.length, 1, "a red gate cannot retry a stage that does not run it");
});

test("uncommitted work left by a stage is committed for it", async () => {
  const { recording } = await exercise(codeStage(implement).run, { gate: [undefined] });
  assert.deepEqual(recording.committed, ["implement: uncommitted changes"]);
});

test("a stage is titled by its name read as a word, and says what it will do", () => {
  assert.equal(codeStage(implement).title, "Implement");
  assert.equal(codeStage(implement).about, "agent · gate");
  assert.equal(codeStage({ name: "spec", prompt: "spec.md" }).about, "agent", "no gate, nothing said about one");
  assert.equal(codeStage({ name: "pr-body", prompt: "pr.md" }).title, "Pr body", "a kebab name reads as words");
  assert.equal(codeStage(implement).name, "implement", "the name is the config's and stays so");
});

test("a stage's model rides on every call in its session", async () => {
  const opus: Stage = { ...implement, model: "opus" };
  const { recording } = await exercise(codeStage(opus).run, {
    gate: [{ name: "compile", command: "tsc", output: "boom" }, undefined],
  });
  assert.deepEqual(
    recording.agent.map((call) => call.model),
    ["opus", "opus"],
    "the gate retry is the same conversation, so it cannot be a different model",
  );

  const { recording: unset } = await exercise(codeStage(implement).run, { gate: [undefined] });
  assert.deepEqual(
    unset.agent.map((call) => call.model),
    [undefined],
    "a stage that names none leaves the CLI's own default standing",
  );
});
