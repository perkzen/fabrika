import type { Config } from "../config.ts";
import { PULL_REQUEST } from "../domain/choices.ts";
import { pipeline, type Pipeline } from "./step.ts";
import { nameBranch } from "./steps/branch.ts";
import { preflight } from "./steps/preflight.ts";
import { openPullRequest } from "./steps/pull-request.ts";
import { reviewRounds } from "./steps/review.ts";
import { codeStage } from "./steps/stage.ts";
import { prepareWorkspace } from "./steps/workspace.ts";

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
