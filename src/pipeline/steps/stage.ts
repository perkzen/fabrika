import { Effect } from "effect";
import { matchesAny, type Stage } from "../../config.ts";
import { Agent } from "../../ports/agent.ts";
import { Gate } from "../../ports/gate.ts";
import { Journal } from "../../ports/journal.ts";
import { Prompts } from "../../ports/prompts.ts";
import { RunContext } from "../../ports/run-context.ts";
import { RunStore } from "../../ports/run-store.ts";
import { Workspace } from "../../ports/workspace.ts";
import { Escalated } from "../escalated.ts";
import type { Step } from "../step.ts";

/**
 * One configured stage: run the agent, then hand it the gate's verdict until
 * the gate is green or the run gives up.
 *
 * The retry is why the stage keeps one session: the agent told "compile
 * failed, fix it" is the one that wrote the code. Anything the stage left
 * uncommitted is committed for it — a stage that forgot is a prompt bug, not
 * a reason to lose the work.
 */
export const codeStage = (stage: Stage): Step => ({
  name: stage.name,
  once: true,
  skip: Effect.gen(function* () {
    const type = (yield* RunStore).get().type;
    // Asked first because it costs no port call: an old config's run makes no new one.
    if (stage.only && type && !stage.only.includes(type)) return `${type} ticket; runs for ${stage.only.join(", ")}`;
    if (!stage.when) return undefined;
    const changed = yield* (yield* Workspace).changedFiles;
    // A skip needs changed files that exist and miss, because `spec` and `plan` are reached before any exist; see ADR-0003.
    return changed.length > 0 && !matchesAny(changed, stage.when)
      ? `no changed file matches ${stage.when.join(", ")}`
      : undefined;
  }),
  run: Effect.gen(function* () {
    const { config } = yield* RunContext;
    const agent = yield* Agent;
    const gate = yield* Gate;
    const journal = yield* Journal;
    const prompts = yield* Prompts;
    const workspace = yield* Workspace;

    const systemPromptFile = stage.system ? prompts.file(stage.system) : undefined;
    let next = yield* prompts.render(stage.prompt);
    for (let attempt = 1; attempt <= config.maxIterations; attempt++) {
      yield* journal.log(`stage ${stage.name} (${attempt}/${config.maxIterations})`);
      yield* agent.ask({ stage: stage.name, prompt: next, systemPromptFile, mcp: stage.mcp });
      if (yield* workspace.commitAll(`${stage.name}: uncommitted changes`)) {
        yield* journal.log(`  worktree dirty after ${stage.name}; committed leftovers`);
      }
      if (!stage.gate) return;
      const failure = yield* gate.check;
      if (!failure) return;
      next = gate.feedback(failure);
    }
    return yield* new Escalated({
      reason: `stage ${stage.name}: gate still red after ${config.maxIterations} iterations`,
      worktree: workspace.dir,
    });
  }),
});
