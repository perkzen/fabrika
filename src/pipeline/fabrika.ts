import type { Config } from "../config.ts";
import { pipeline, type Pipeline } from "./step.ts";
import { nameBranch } from "./steps/branch.ts";
import { preflight } from "./steps/preflight.ts";
import { openPullRequest } from "./steps/pull-request.ts";
import { reviewRounds } from "./steps/review.ts";
import { codeStage } from "./steps/stage.ts";
import { prepareWorkspace } from "./steps/workspace.ts";

/**
 * The run fabrika ships: check the config is runnable, name the branch, make
 * the tree, work through the configured stages, open the PR, then loop on the
 * review until it is clean or a human is needed.
 *
 * The configured stages are the middle of it — `spec`, `plan`, `implement`
 * and the rest are data, and so is their order. A caller wanting a different
 * run builds a different list: `fabrikaPipeline(config)` is one arrangement
 * of steps, not the only one the driver can run.
 */
export const fabrikaPipeline = (config: Config): Pipeline =>
  pipeline()
    .step(preflight)
    .step(nameBranch)
    .step(prepareWorkspace)
    .steps(config.stages.map(codeStage))
    .step(openPullRequest)
    .step(reviewRounds)
    .build();
