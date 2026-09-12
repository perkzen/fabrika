import { Effect } from "effect";
import { Agent } from "../ports/agent.ts";
import { Gate } from "../ports/gate.ts";
import { Journal } from "../ports/journal.ts";
import { Prompts } from "../ports/prompts.ts";
import { RunStore } from "../ports/run-store.ts";
import { Workspace } from "../ports/workspace.ts";
import { Escalated } from "./escalated.ts";
import type { StepError, StepServices } from "./step.ts";

/**
 * Keeps the branch mergeable while the base moves, and keeps it green after.
 *
 * Merge, never rebase: pushed commits stay put, so the reviewer's per-commit
 * findings stay valid. Conflicts go to the agent — in the round's own session,
 * so a second conflict in the same round is handed to the agent that resolved
 * the first. Answers `true` when HEAD moved, which is the caller's cue to push.
 */
export const syncWithBase = (prUrl?: string): Effect.Effect<boolean, StepError, StepServices> =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const journal = yield* Journal;
    const agent = yield* Agent;
    const gate = yield* Gate;
    const prompts = yield* Prompts;
    const store = yield* RunStore;

    const escalate = (reason: string) => new Escalated({ reason, worktree: workspace.dir, prUrl });
    const session = `merge-${store.get().round}`;
    const implementer = prompts.file("implement.system.md");

    const outcome = yield* workspace.mergeBase;
    if (outcome._tag === "UpToDate") return false;
    if (outcome._tag === "Failed") return yield* escalate(`git merge failed: ${outcome.output}`);

    yield* journal.log(`base moved: ${outcome.behind} commit(s) behind; merging`);
    if (outcome._tag === "Conflicted") {
      yield* journal.log(`  ${outcome.files.length} conflicted file(s); resolving`);
      yield* agent.ask({
        stage: "merge",
        session,
        prompt: yield* prompts.render("merge.md", { files: outcome.files.map((file) => `- ${file}`).join("\n") }),
        systemPromptFile: implementer,
      });
      const left = yield* workspace.conflictedFiles;
      if (left.length > 0) return yield* escalate(`merge left conflicts in ${left.join(", ")}`);
      // Resolved but not committed: the same safety net a dirty stage gets.
      yield* workspace.finishMerge;
    }

    const failure = yield* gate.check;
    if (failure) {
      yield* journal.log(`  gate red after merge; one repair pass`);
      yield* agent.ask({ stage: "merge-gate", session, prompt: gate.feedback(failure), systemPromptFile: implementer });
      const again = yield* gate.check;
      if (again) return yield* escalate(`gate red after merging the base: ${again.name}`);
    }
    return true;
  });
