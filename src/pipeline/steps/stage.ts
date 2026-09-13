import { Effect } from "effect";
import type { Stage } from "../../config.ts";
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
 * A stage's name, read as a word: `implement` is `Implement`, `pr-body` is
 * `Pr body`. The config's pattern keeps names to lower-case kebab, so this is
 * the whole of what there is to undo; the name itself is still what every
 * plain line and the completed list say.
 */
const titleOf = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " ");

/**
 * What a stage will do, for its row before it has done it: an agent call,
 * the gate after it if the stage has one, and the ticket types it runs for
 * if it does not run for all of them.
 */
const aboutOf = (stage: Stage): string =>
  ["agent", ...(stage.gate ? ["gate"] : []), ...(stage.only ? [`${stage.only.join("/")} only`] : [])].join(" · ");

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
  title: titleOf(stage.name),
  about: aboutOf(stage),
  once: true,
  skip: Effect.gen(function* () {
    const type = (yield* RunStore).get().type;
    return stage.only && type && !stage.only.includes(type)
      ? `${type} ticket; runs for ${stage.only.join(", ")}`
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
