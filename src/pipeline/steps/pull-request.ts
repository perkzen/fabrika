import { Effect } from "effect";
import { beforeAfter, type Section } from "../../captures.ts";
import { applies, type CaptureStep } from "../../config.ts";
import { Captures } from "../../ports/captures.ts";
import { Forge } from "../../ports/forge.ts";
import { Journal } from "../../ports/journal.ts";
import { RunContext } from "../../ports/run-context.ts";
import { RunStore } from "../../ports/run-store.ts";
import { Workspace } from "../../ports/workspace.ts";
import { Escalated } from "../escalated.ts";
import type { Step } from "../step.ts";
import { syncWithBase } from "../sync.ts";

const TRAILER = "Opened by fabrika. Draft until a human reviews.";

/**
 * The posted body. Called for both bodies, so the one with the section and
 * the one without differ by exactly the section.
 */
const composeBody = (link: string, description: string, section: string | undefined) =>
  [link, "", description, "", ...(section ? [section, ""] : []), "---", TRAILER].join("\n");

/**
 * The Before / After section, or `undefined` when there is nothing to show.
 *
 * Every port call here is an `orElseSucceed` back to silence: a capture may
 * never fail a run, and this is where the step gained the calls that could.
 */
const captureSection = (
  captures: ReadonlyArray<CaptureStep>,
  headSha: string,
): Effect.Effect<Section | undefined, never, Captures | Workspace> =>
  Effect.gen(function* () {
    if (captures.length === 0) return undefined;
    const workspace = yield* Workspace;
    const changed = yield* workspace.changedFiles.pipe(Effect.orElseSucceed(() => []));
    const applicable = captures.filter((capture) => applies(capture.when, changed));
    // Nothing below this line runs on a branch that changed no captured
    // surface, so a docs-only run costs exactly what it costs today.
    if (applicable.length === 0) return undefined;
    const baseSha = yield* workspace.baseSha.pipe(Effect.orElseSucceed(() => ""));
    if (!baseSha) return undefined;
    const shots = yield* (yield* Captures).take(applicable, baseSha);
    return beforeAfter(shots, { baseSha, headSha, images: true });
  });

/**
 * Pushes the branch and opens the pull request, once.
 *
 * Draft by default: everything after this is a machine reviewing a machine,
 * and the PR does not claim to be ready until a human has looked. The body is
 * whatever the review stage wrote to `pr.md`, falling back to the ticket's own
 * description, plus the Before / After section when a capture had something
 * to show.
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
    const link = ticket.url ? `Linear: ${ticket.url}` : "";
    const section = yield* captureSection(config.pr.capture ?? [], head);

    const pr = yield* forge.open({
      branch,
      title: `${ticket.identifier}: ${ticket.title}`,
      body: composeBody(link, description, section?.markdown),
      draft: config.pr.draft,
      attachments: section?.attachments ?? [],
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
