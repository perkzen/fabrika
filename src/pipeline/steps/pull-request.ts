import { Effect } from "effect";
import { Forge } from "../../ports/forge.ts";
import { Journal } from "../../ports/journal.ts";
import { RunContext } from "../../ports/run-context.ts";
import { RunStore } from "../../ports/run-store.ts";
import { Workspace } from "../../ports/workspace.ts";
import { titleOf, TRAILER } from "../../stamp.ts";
import { Escalated } from "../escalated.ts";
import type { Step } from "../step.ts";
import { syncWithBase } from "../sync.ts";

/**
 * Pushes the branch and opens the pull request, once.
 *
 * Draft by default: everything after this is a machine reviewing a machine,
 * and the PR does not claim to be ready until a human has looked. The body is
 * whatever the review stage wrote to `pr.md`, falling back to the ticket's own
 * description.
 */
export const openPullRequest: Step = {
  name: "pull-request",
  run: Effect.gen(function* () {
    const { ticket, config } = yield* RunContext;
    const workspace = yield* Workspace;
    const forge = yield* Forge;
    const store = yield* RunStore;
    const journal = yield* Journal;

    const commits = yield* workspace.commitCount;
    if (commits === 0) {
      return yield* new Escalated({ reason: "no commits after all stages", worktree: workspace.dir });
    }
    if (store.get().prNumber !== null) return;

    const branch = store.get().branch!;
    yield* syncWithBase();
    yield* journal.log(`pushing ${commits} commit(s) to ${branch}`);
    yield* workspace.push(branch);
    const head = yield* workspace.head;
    yield* store.update((state) => void state.pushed.push(head));

    const description = (yield* workspace.readArtifact("pr.md")) ?? ticket.description;
    const pr = yield* forge.open({
      branch,
      title: titleOf(ticket.identifier, ticket.title),
      body: [
        ticket.url ? `Linear: ${ticket.url}` : "",
        "",
        description,
        "",
        "---",
        TRAILER,
      ].join("\n"),
      draft: config.pr.draft,
    });
    yield* store.update((state) => void (state.prNumber = pr.number));
    yield* journal.log(`PR ${pr.url}`);

    if (config.pr.emptyCommit) {
      // A preview deployment is skipped when its commit predates the PR.
      yield* workspace.emptyCommit("chore: trigger preview deployment");
      yield* workspace.push(branch);
      const retriggered = yield* workspace.head;
      yield* store.update((state) => void state.pushed.push(retriggered));
    }
  }),
};
