import { Effect } from "effect";
import { Agent } from "../../ports/agent.ts";
import { Forge, type Check } from "../../ports/forge.ts";
import { Gate } from "../../ports/gate.ts";
import { Journal } from "../../ports/journal.ts";
import { Prompts } from "../../ports/prompts.ts";
import { Reviewer, type Decision } from "../../ports/reviewer.ts";
import { RunContext } from "../../ports/run-context.ts";
import { RunStore } from "../../ports/run-store.ts";
import { Workspace } from "../../ports/workspace.ts";
import { Escalated } from "../escalated.ts";
import type { Step } from "../step.ts";
import { syncWithBase } from "../sync.ts";

const renderFailures = (failures: ReadonlyArray<{ check: Check; log: string }>) =>
  failures.map(({ check, log }) => `### ${check.name}\n${check.url}\n\n\`\`\`\n${log}\n\`\`\``).join("\n\n");

/**
 * The loop that decides when the branch is ready for a human.
 *
 * Done means everything the configured reviewer can say is satisfied, on the
 * commit that was actually pushed: no check is failing, no review thread is
 * open, and — for a reviewer that scores — the score is the one the config
 * demands. A reviewer with no bot behind it seeks no verdict, so its rounds
 * turn on the checks alone. Anything less is fed back to the agent — threads
 * and CI logs in the round's own session — and the round starts again.
 * Everything the agent could act on is exhausted before the run gives up, and
 * a round that finds nothing actionable escalates immediately rather than
 * waiting for the same verdict again.
 */
export const reviewRounds: Step = {
  name: "review",
  run: Effect.gen(function* () {
    const { config } = yield* RunContext;
    const agent = yield* Agent;
    const forge = yield* Forge;
    const gate = yield* Gate;
    const journal = yield* Journal;
    const prompts = yield* Prompts;
    const reviewer = yield* Reviewer;
    const store = yield* RunStore;
    const workspace = yield* Workspace;

    const pr = store.get().prNumber!;
    const url = forge.urlOf(pr);
    const escalate = (reason: string) => new Escalated({ reason, worktree: workspace.dir, prUrl: url });
    const implementer = prompts.file("implement.system.md");
    const checksTimeout = config.checks?.timeoutMinutes ?? config.review.timeoutMinutes;

    /** The pushed commit's failing checks, or an escalation if they never settle. */
    const failingChecks = (sha: string) =>
      forge.settledChecks(pr, sha, checksTimeout).pipe(
        Effect.flatMap((all) =>
          all
            ? Effect.succeed(all.filter((check) => check.state === "fail"))
            : Effect.fail(escalate(`checks still pending after ${checksTimeout} min`)),
        ),
      );

    while (store.get().round < config.review.maxRounds) {
      yield* store.update((state) => void (state.round += 1));
      const round = store.get().round;
      yield* journal.log(`review round ${round}/${config.review.maxRounds}`);

      if (yield* syncWithBase(url)) {
        yield* workspace.push(store.get().branch!);
        const head = yield* workspace.head;
        yield* store.update((state) => void (state.pushed = [head]));
      }

      const review = yield* reviewer.await(pr, store.get().pushed, config.review.timeoutMinutes);
      if (!review) return yield* escalate(`no ${reviewer.name} review within ${config.review.timeoutMinutes} min`);
      const threads = review.threads;
      const pushedHead = store.get().pushed.at(-1)!;

      let failed = yield* failingChecks(pushedHead);
      // One rerun per CI run, for flakes; a failure that survives it is the agent's.
      const flaky = failed.filter((check) => check.job && !store.get().reran.includes(check.job.id));
      if (flaky.length > 0) {
        for (const check of flaky) {
          yield* forge.rerun(check);
          yield* store.update((state) => void state.reran.push(check.job!.id));
        }
        yield* journal.log(`  reran ${flaky.length} failed run(s) once in case of flakes`);
        failed = yield* failingChecks(pushedHead);
      }

      // With no reviewer there is no score to report, so the line names what decided the round.
      const verdict = reviewer.scores
        ? `score ${review.score ?? "none"}/5, ${threads.length} open thread(s), `
        : "no reviewer, ";
      yield* journal.log(`  ${verdict}${failed.length} failing check(s)`);
      const scoreOk = !reviewer.scores || (review.score !== null && review.score >= config.review.requireScore);
      if (scoreOk && threads.length === 0 && failed.length === 0) {
        yield* store.update((state) => void (state.done = true));
        const kept = yield* store.archive(workspace.artifactsDir);
        if (kept) yield* journal.log(`artifacts: ${kept}`);
        yield* workspace.remove;
        // Returned rather than logged: the driver writes it after this step's
        // `end`, so the URL stays the last line of stdout. Both wordings end
        // with it, because that is the piped contract.
        return reviewer.scores
          ? `done: ${reviewer.name} ${review.score}/5, no open threads, checks green — ready for human review: ${url}`
          : `done: no review bot, checks green — ready for human review: ${url}`;
      }
      if (reviewer.scores && threads.length === 0 && failed.length === 0) {
        // Nothing the agent can act on, and the next round would find the same review; with no score to fall short of, `scores: false` cannot get here.
        return yield* escalate(
          `${reviewer.name} score ${review.score ?? "missing"}/5 with no open threads or failing checks to act on`,
        );
      }

      const before = yield* workspace.head;
      let decisions: ReadonlyArray<Decision> = [];
      if (threads.length > 0) {
        const reply = yield* agent.ask({
          stage: reviewer.name,
          session: `round-${round}`,
          prompt: yield* prompts.render(reviewer.prompts.threads, {
            count: String(threads.length),
            threads: reviewer.renderThreads(threads),
          }),
          systemPromptFile: prompts.file(reviewer.prompts.system),
          jsonSchema: reviewer.decisionSchema,
        });
        decisions = ((reply.structured as { decisions?: Array<Decision> } | undefined)?.decisions ?? []).filter((decision) =>
          threads.some((thread) => thread.id === decision.threadId),
        );
        yield* workspace.commitAll("review: address review findings");
      }
      if (failed.length > 0) {
        const failures: Array<{ check: Check; log: string }> = [];
        for (const check of failed) failures.push({ check, log: yield* forge.failureLog(check) });
        yield* agent.ask({
          stage: "ci",
          session: `round-${round}`,
          prompt: yield* prompts.render("ci.md", {
            count: String(failed.length),
            sha: pushedHead.slice(0, 7),
            failures: renderFailures(failures),
          }),
          systemPromptFile: implementer,
        });
        yield* workspace.commitAll("fix(ci): address failing checks");
      }

      const failure = yield* gate.check;
      if (failure) {
        yield* journal.log(`  gate red after review fixes; one repair pass`);
        yield* agent.ask({
          stage: `${reviewer.name}-gate`,
          session: `round-${round}`,
          prompt: gate.feedback(failure),
          systemPromptFile: implementer,
        });
        const again = yield* gate.check;
        if (again) return yield* escalate(`gate red after review round ${round}: ${again.name}`);
      }

      const touched = yield* workspace.filesSince(before);
      if ((yield* workspace.head) !== before) {
        yield* workspace.push(store.get().branch!);
        const head = yield* workspace.head;
        yield* store.update((state) => void (state.pushed = [head]));
      }

      for (const decision of decisions) {
        const thread = threads.find((t) => t.id === decision.threadId)!;
        yield* reviewer.reply(decision.threadId, decision.reply);
        // Resolve only under the two conditions: a claimed fix with no commit
        // touching that file stays open for the human.
        const mayResolve = decision.action === "disputed" || touched.includes(thread.path);
        yield* journal.log(`  ${decision.action} ${thread.path}${mayResolve ? "" : " — left open: no commit touched it"}`);
        if (mayResolve) yield* reviewer.resolve(decision.threadId);
      }
    }
    return yield* escalate(`not clean after ${config.review.maxRounds} review rounds`);
  }),
};
