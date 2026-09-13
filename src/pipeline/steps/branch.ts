import { Effect } from "effect";
import { Agent } from "../../ports/agent.ts";
import { Journal } from "../../ports/journal.ts";
import { Prompts } from "../../ports/prompts.ts";
import { RunContext } from "../../ports/run-context.ts";
import { RunStore } from "../../ports/run-store.ts";
import { Workspace } from "../../ports/workspace.ts";
import { asBranchParts, branchName, BRANCH_SCHEMA, defaultParts } from "../../domain/ticket.ts";
import type { Step } from "../step.ts";

/**
 * Names the branch, once per run.
 *
 * An existing worktree pins it. Otherwise one short structured call applies
 * the `fabrika:branch-naming` skill — it reads the ticket more carefully than
 * a label regex, so its verdict on the type is the one the branch and every
 * prompt's `{type}` carry — and the deterministic parts stand in whenever the
 * answer breaks the naming rules or the call fails outright. The result is
 * saved before anything is built on it, because a resume has to land on the
 * same branch.
 */
export const nameBranch: Step = {
  name: "branch",
  title: "Branch",
  about: "agent · branch name",
  run: Effect.gen(function* () {
    const { ticket, config } = yield* RunContext;
    const store = yield* RunStore;
    const journal = yield* Journal;
    const prompts = yield* Prompts;

    if (store.get().branch === null) {
      const workspace = yield* Workspace;
      if (yield* workspace.exists) {
        const current = yield* workspace.currentBranch;
        yield* store.update((state) => void (state.branch = current));
      } else {
        const agent = yield* Agent;
        const named = yield* agent
          .ask({
            stage: "branch",
            prompt: yield* prompts.render("branch.md"),
            jsonSchema: BRANCH_SCHEMA,
            cwd: workspace.repoRoot,
          })
          .pipe(
            Effect.map((reply) => asBranchParts(reply.structured)),
            Effect.catchTag("AgentFailed", (error) =>
              journal.log(`  naming call failed (${error.message.slice(0, 80)}); using the default name`).pipe(Effect.as(null)),
            ),
          );
        if (!named) yield* journal.log(`  naming answer rejected; using the default name`);
        const user = config.branch.includes("{user}") ? yield* workspace.user : "";
        const parts = named ?? defaultParts(ticket);
        yield* store.update((state) => {
          if (named) state.type = named.type;
          state.branch = branchName(config.branch, ticket, parts, config.previewPrefix ?? "", user);
        });
      }
    }

    // No naming call ran — an existing worktree pinned the branch, or the
    // call failed — so the ticket's own type stands in.
    yield* store.update((state) => void (state.type ??= ticket.type));
    const state = store.get();
    prompts.define("type", state.type!);
    prompts.define("branch", state.branch!);
    yield* journal.log(`branch ${state.branch} off ${config.base}`);
  }),
};
