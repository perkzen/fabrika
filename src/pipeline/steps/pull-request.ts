import { Effect } from "effect";
import { beforeAfter, type Section } from "../../captures.ts";
import { applies, type CaptureStep } from "../../config.ts";
import { Captures } from "../../ports/captures.ts";
import { Forge } from "../../ports/forge.ts";
import { Journal } from "../../ports/journal.ts";
import { RunContext } from "../../ports/run-context.ts";
import { RunStore } from "../../ports/run-store.ts";
import { Workspace } from "../../ports/workspace.ts";
import { titleOf, TRAILER } from "../../pull-request.ts";
import { Escalated } from "../escalated.ts";
import type { Step } from "../step.ts";
import { syncWithBase } from "../sync.ts";

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
): Effect.Effect<Section | undefined, never, Captures | Forge | Journal | Workspace> =>
  Effect.gen(function* () {
    if (captures.length === 0) return undefined;
    const workspace = yield* Workspace;
    const changed = yield* workspace.changedFiles.pipe(Effect.orElseSucceed(() => []));
    const applicable = captures.filter((capture) => applies(capture.when, changed));
    // Nothing below this line runs on a branch that changed no captured
    // surface, so a docs-only run costs exactly what it costs today.
    if (applicable.length === 0) return undefined;
    const baseSha = yield* workspace.baseSha.pipe(Effect.orElseSucceed(() => ""));
    // A sha, or nothing: `git rev-parse` can warn on stderr and still exit
    // zero, and the adapter interleaves the two. The captures make a directory
    // of this string and empty it recursively, and print it into the body.
    if (!/^[0-9a-f]{7,64}$/.test(baseSha)) {
      yield* Effect.flatMap(Journal, (journal) => journal.log("captures: no section — the base did not resolve to a commit"));
      return undefined;
    }
    const shots = yield* (yield* Captures).take(applicable, baseSha);
    if (shots.length === 0) return undefined;
    // Read only now: `attaches` shells out to `gh --version`, and a run with
    // nothing to show must touch nothing.
    const images = yield* (yield* Forge).attaches;
    return beforeAfter(shots, { baseSha, headSha, images });
  });

/**
 * Puts the plain body back when the forge left a host path in the posted one.
 *
 * `gh` matches an attachment to the body by absolute path and silently leaves
 * the path alone on a mismatch, and nothing a reader is sent to may be a
 * place only this machine can go. The pull request is already open and its
 * number already stored, so a failure here is a note rather than a run.
 */
const withoutHostPaths = (pr: number, attachments: ReadonlyArray<string>, plain: string) =>
  Effect.gen(function* () {
    const forge = yield* Forge;
    const journal = yield* Journal;
    const posted = yield* forge.body(pr);
    if (!attachments.some((path) => posted.includes(path))) return;
    yield* journal.log("the posted body still points at this host; putting back the one without the captures");
    yield* forge.editBody(pr, plain);
  }).pipe(
    Effect.catchTag("FabrikaError", (error) =>
      Effect.flatMap(Journal, (journal) => journal.log(`could not check the posted body: ${error.message}`)),
    ),
  );

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

    const plain = composeBody(link, description, undefined);
    const opening = { branch, title: titleOf(ticket.identifier, ticket.title), draft: config.pr.draft };
    const uploading = section?.attachments ?? [];
    const pr = yield* forge
      .open({ ...opening, body: composeBody(link, description, section?.markdown), attachments: uploading })
      .pipe(
        // Push access is already proven by the push above, so a create that
        // fails while carrying attachments failed on the upload. Only the
        // second attempt failing escalates, which is today's behaviour.
        Effect.catchTag("FabrikaError", (error) =>
          uploading.length > 0
            ? journal
                .log(`the pull request would not take the captures (${error.message}); opening it without them`)
                .pipe(Effect.andThen(forge.open({ ...opening, body: plain, attachments: [] })))
            : Effect.fail(error),
        ),
      );
    // Stored before anything else is asked of the forge: a crash past this
    // line resumes onto this pull request rather than opening a second one.
    yield* store.update((state) => void (state.prNumber = pr.number));
    yield* journal.log(`PR ${pr.url}`);

    // Asked whether or not the upload survived. The body that opened after a
    // rejected upload is the plain one, so the read-back finds no host path
    // and does nothing — one `pr view` on a path that has already gone wrong,
    // against threading the attachments back out of the create just to skip it.
    if (uploading.length > 0) yield* withoutHostPaths(pr.number, uploading, plain);

    if (config.pr.emptyCommit) {
      // A preview deployment is skipped when its commit predates the PR.
      yield* workspace.emptyCommit("chore: trigger preview deployment");
      yield* workspace.push(branch);
      const retriggered = yield* workspace.head;
      yield* store.update((state) => void state.pushed.push(retriggered));
    }
  }),
};
