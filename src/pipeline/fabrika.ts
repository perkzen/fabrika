import type { Config } from "../config.ts";
import { pipeline, type Pipeline } from "./step.ts";
import { nameBranch } from "./steps/branch.ts";
import { preflight } from "./steps/preflight.ts";
import { openPullRequest } from "./steps/pull-request.ts";
import { reviewRounds } from "./steps/review.ts";
import { codeStage } from "./steps/stage.ts";
import { prepareWorkspace } from "./steps/workspace.ts";

/**
 * The name the pull request and the review loop are chosen by, together.
 *
 * They are one choice rather than two because the loop has nothing to loop
 * on without the PR — its rounds are keyed by `prNumber` — and because the
 * loop's step is also called `review`, which is the shipped config's last
 * stage. One name for the pair keeps every choice unambiguous.
 */
export const PULL_REQUEST = "pull-request";

/** What a run may be asked to leave out: its stages, and the pull request with its review loop. */
export type Choice = {
  readonly name: string;
  readonly title: string;
  /** The outline's few dim words, for the row a run draws while the step is pending. */
  readonly about: string;
  /** A sentence, for the one row the select gives whatever the operator is standing on. */
  readonly description: string;
};

/**
 * The choices a run offers, in the order it would run them.
 *
 * Read off the config rather than fixed, because the stages are the config's
 * and a repo is free to name its own. `preflight`, `branch` and `workspace`
 * are not here: a run with no worktree has nowhere to do anything, so they
 * are not a choice anyone benefits from being offered.
 */
export const choices = (config: Config): ReadonlyArray<Choice> => [
  ...config.stages.map((stage) => {
    const step = codeStage(stage);
    return {
      name: step.name,
      title: step.title ?? step.name,
      about: step.about ?? "",
      description: stage.gate
        ? `One agent session on ${stage.prompt}, then your gate until it passes.`
        : `One agent session on ${stage.prompt}.`,
    };
  }),
  {
    name: PULL_REQUEST,
    title: "Pull request",
    about: "draft PR · review rounds",
    description: "Opens the draft pull request, then loops on the review until it is clean or a human is needed.",
  },
];

/**
 * The chosen names that name nothing, so a typo is a CLI error rather than a
 * stage silently not running. Duplicates and order are nobody's business:
 * what is chosen is a set, and the run's order is the config's either way.
 */
export const unknown = (config: Config, chosen: ReadonlyArray<string>): ReadonlyArray<string> => {
  const offered = new Set(choices(config).map((choice) => choice.name));
  return chosen.filter((name) => !offered.has(name));
};

/**
 * The run fabrika ships: check the config is runnable, name the branch, make
 * the tree, work through the chosen stages, open the PR, then loop on the
 * review until it is clean or a human is needed.
 *
 * The configured stages are the middle of it — `spec`, `plan`, `implement`
 * and the rest are data, and so is their order. A caller wanting a different
 * run builds a different list: `fabrikaPipeline(config)` is one arrangement
 * of steps, not the only one the driver can run.
 *
 * `chosen` leaves steps out rather than skipping them, so what the run event
 * announces and what the outline shows is the run the operator asked for —
 * a step nobody chose was never part of this run, and a skipped one would
 * claim it was. Absent, every step runs, which is what a pipe and a schedule
 * get.
 */
export const fabrikaPipeline = (config: Config, chosen?: ReadonlyArray<string>): Pipeline => {
  const wanted = chosen && new Set(chosen);
  const stages = wanted ? config.stages.filter((stage) => wanted.has(stage.name)) : config.stages;
  const pullRequest = !wanted || wanted.has(PULL_REQUEST);
  return pipeline()
    .step(preflight)
    .step(nameBranch)
    .step(prepareWorkspace)
    .steps(stages.map(codeStage))
    .steps(pullRequest ? [openPullRequest, reviewRounds] : [])
    .build();
};
