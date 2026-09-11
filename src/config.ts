import { Data, Effect, FileSystem, Path, Schema } from "effect";

export const Stage = Schema.Struct({
  name: Schema.String,
  prompt: Schema.String,
  system: Schema.optional(Schema.String),
  mcp: Schema.optional(Schema.Array(Schema.String)),
  gate: Schema.optional(Schema.Boolean),
  /** Ticket types this stage runs for, as the naming call decided; every type when absent. */
  only: Schema.optional(Schema.Array(Schema.Literals(["feat", "fix", "chore"]))),
});
export type Stage = typeof Stage.Type;

export const GateStep = Schema.Struct({
  name: Schema.String,
  run: Schema.String,
  /** Glob patterns; the step runs only when a changed file matches one. */
  when: Schema.optional(Schema.Array(Schema.String)),
});
export type GateStep = typeof GateStep.Type;

export const Config = Schema.Struct({
  base: Schema.String,
  /** Branch pattern; `{user}` (`git config user.name`, kebab-cased), `{type}`, `{ticket}` and `{slug}` are filled per run. */
  branch: Schema.String,
  /** Prepended to `branch` when the naming call decides the ticket wants a preview deployment. */
  previewPrefix: Schema.optional(Schema.String),
  install: Schema.optional(Schema.String),
  gate: Schema.Array(GateStep),
  stages: Schema.Array(Stage),
  /** Permission rules the Claude subprocess is denied; the runner does its own pushing, PR opening and merging. */
  deny: Schema.Array(Schema.String),
  pr: Schema.Struct({ draft: Schema.Boolean, emptyCommit: Schema.Boolean }),
  review: Schema.Struct({
    provider: Schema.Literal("cubic"),
    requireScore: Schema.Number,
    maxRounds: Schema.Number,
    timeoutMinutes: Schema.Number,
  }),
  /** How long to wait for the PR's checks after a push; defaults to the review timeout. */
  checks: Schema.optional(Schema.Struct({ timeoutMinutes: Schema.Number })),
  maxIterations: Schema.Number,
});
export type Config = typeof Config.Type;

export const CONFIG_PATH = ".fabrika/config.json";

export class ConfigNotFound extends Data.TaggedError("ConfigNotFound")<{ readonly path: string }> {}

export const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Config));

export const loadConfig = (repoRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(repoRoot, CONFIG_PATH);
    const raw = yield* fs.readFileString(file).pipe(Effect.mapError(() => new ConfigNotFound({ path: file })));
    return yield* decodeConfig(raw);
  });

/**
 * Written by `fabrika init`; typed, so it cannot drift from the schema.
 *
 * `base`, `install` and `gate` are left neutral here and filled in per repo by
 * the `fabrika:configure` call in `configure.ts`: a gate command that does not
 * exist in the target repo is worse than no gate at all, because the failing
 * output goes back to the agent as "fix it" on code it never touched.
 */
export const CONFIG_TEMPLATE: Config = {
  base: "origin/main",
  branch: "{user}/{type}/{ticket}/{slug}",
  previewPrefix: "preview/",
  // Present so `init` keeps the key in this position when it fills one in;
  // `JSON.stringify` drops it when the repo needs no install step.
  install: undefined,
  gate: [],
  stages: [
    { name: "spec", prompt: "spec.md", system: "plan.system.md", mcp: ["linear-ro"] },
    { name: "plan", prompt: "plan.md", system: "plan.system.md" },
    { name: "implement", prompt: "implement.md", system: "implement.system.md", gate: true },
    // A fix or a chore rarely has architecture worth reshaping, and the stage
    // costs a cold start plus a full gate run; security stays on for everything.
    { name: "refactor", prompt: "refactor.md", system: "implement.system.md", gate: true, only: ["feat"] },
    { name: "security", prompt: "security.md", system: "implement.system.md", gate: true },
    { name: "review", prompt: "review.md", system: "implement.system.md", gate: true },
  ],
  deny: ["Bash(git push:*)", "Bash(gh pr merge:*)", "Bash(gh pr review:*)", "Bash(gh api graphql:*)"],
  pr: { draft: true, emptyCommit: true },
  review: { provider: "cubic", requireScore: 5, maxRounds: 3, timeoutMinutes: 25 },
  checks: { timeoutMinutes: 30 },
  maxIterations: 4,
};
