import { Effect } from "effect";
import { CONFIG_PATH } from "../../config.ts";
import { FabrikaError } from "../../errors.ts";
import { Agent } from "../../ports/agent.ts";
import { Journal } from "../../ports/journal.ts";
import { Prompts } from "../../ports/prompts.ts";
import { RunContext } from "../../ports/run-context.ts";
import type { Step } from "../step.ts";

/**
 * Fails on a prompt file that does not exist, or an MCP server a stage names
 * that cannot be provided — before the run spends an install and two stages
 * getting there. A config written by an older `init` can still name a prompt
 * that no longer ships.
 */
export const preflight: Step = {
  name: "preflight",
  title: "Preflight",
  about: "config check",
  run: Effect.gen(function* () {
    const { ticket, config } = yield* RunContext;
    const prompts = yield* Prompts;
    const agent = yield* Agent;
    const journal = yield* Journal;

    yield* journal.log(`${ticket.identifier} — ${ticket.title}`);
    for (const stage of config.stages) {
      for (const file of [stage.prompt, stage.system]) {
        if (file && !(yield* prompts.exists(file))) {
          return yield* new FabrikaError({
            message: `stage ${stage.name}: prompts/${file} does not exist — update the stages in ${CONFIG_PATH}`,
          });
        }
      }
      if (stage.mcp?.length) yield* agent.ensureTools(stage.mcp);
    }
  }),
};
