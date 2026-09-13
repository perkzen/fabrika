import type { Config, Stage } from "../config.ts";

/**
 * What a run may be asked to leave out, and what a reader calls each of them.
 *
 * A fact about the config rather than about the pipeline: the choices are the
 * configured stages in their configured order, plus the pull request and its
 * review loop. Here rather than beside the steps because the question is
 * asked before a run is assembled — the select draws these rows and the CLI
 * validates `--steps` against them, and neither has any business building a
 * step to read its title off.
 */

/**
 * The name the pull request and the review loop are chosen by, together.
 *
 * They are one choice rather than two because the loop has nothing to loop
 * on without the PR — its rounds are keyed by `prNumber` — and because the
 * loop's step is also called `review`, which is the shipped config's last
 * stage. One name for the pair keeps every choice unambiguous.
 */
export const PULL_REQUEST = "pull-request";

export type Choice = {
  readonly name: string;
  readonly title: string;
  /** The outline's few dim words, for the row a run draws while the step is pending. */
  readonly about: string;
  /** A sentence, for the one row the select gives whatever the operator is standing on. */
  readonly description: string;
};

/**
 * A stage's name, read as a word: `implement` is `Implement`, `pr-body` is
 * `Pr body`. The config's pattern keeps names to lower-case kebab, so this is
 * the whole of what there is to undo; the name itself is still what every
 * plain line and the completed list say.
 */
export const titleOf = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " ");

/**
 * What a stage will do, for its row before it has done it: an agent call, and
 * the gate after it if the stage has one.
 */
export const aboutOf = (stage: Stage): string => ["agent", ...(stage.gate ? ["gate"] : [])].join(" · ");

/**
 * The choices a run offers, in the order it would run them.
 *
 * Read off the config rather than fixed, because the stages are the config's
 * and a repo is free to name its own. `preflight`, `branch` and `workspace`
 * are not here: a run with no worktree has nowhere to do anything, so they
 * are not a choice anyone benefits from being offered.
 */
export const choices = (config: Config): ReadonlyArray<Choice> => [
  ...config.stages.map((stage) => ({
    name: stage.name,
    title: titleOf(stage.name),
    about: aboutOf(stage),
    description: stage.gate
      ? `One agent session on ${stage.prompt}, then your gate until it passes.`
      : `One agent session on ${stage.prompt}.`,
  })),
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
