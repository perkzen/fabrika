import { Data, Effect, FileSystem, Path, Schema } from "effect";
import { matchesGlob } from "node:path";

export const Stage = Schema.Struct({
  name: Schema.String,
  prompt: Schema.String,
  system: Schema.optional(Schema.String),
  /** Which model this stage's calls run on; the top-level `model` when absent, and the CLI's own default when that is absent too. */
  model: Schema.optional(Schema.String),
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

export const CaptureStep = Schema.Struct({
  /**
   * The same kebab-case label `configure` proposes, enforced here too: the
   * host makes a directory of it under the capture cache and empties that
   * directory before every run, so a name that is a path is a recursive
   * delete somewhere nobody asked for — and the name is printed into the
   * pull-request body, where a backtick or a pipe would be markdown.
   */
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  run: Schema.String,
  /** Glob patterns; the capture runs only when a changed file matches one. */
  when: Schema.optional(Schema.Array(Schema.String)),
  /** Killed and its half dropped after this long; `DEFAULT_CAPTURE_MINUTES` when absent. */
  timeoutMinutes: Schema.optional(Schema.Number),
});
export type CaptureStep = typeof CaptureStep.Type;

/**
 * Whether a step with these globs applies to a branch that changed these
 * files. No globs means every branch. Lives beside the `when` field it
 * interprets, so the gate and the captures share one matcher rather than two
 * that can drift.
 */
export const applies = (when: ReadonlyArray<string> | undefined, changed: ReadonlyArray<string>): boolean =>
  !when || changed.some((file) => when.some((glob) => matchesGlob(file, glob)));

export const Config = Schema.Struct({
  base: Schema.String,
  /** Branch pattern; `{user}` (`git config user.name`, kebab-cased), `{type}`, `{ticket}` and `{slug}` are filled per run. */
  branch: Schema.String,
  /** Prepended to `branch` when the naming call decides the ticket wants a preview deployment. */
  previewPrefix: Schema.optional(Schema.String),
  install: Schema.optional(Schema.String),
  gate: Schema.Array(GateStep),
  /** The model every agent call takes unless a stage names its own; the CLI's own default when absent. */
  model: Schema.optional(Schema.String),
  stages: Schema.Array(Stage),
  /** Permission rules the Claude subprocess is denied; the runner does its own pushing, PR opening and merging. */
  deny: Schema.Array(Schema.String),
  pr: Schema.Struct({
    draft: Schema.Boolean,
    emptyCommit: Schema.Boolean,
    capture: Schema.optional(Schema.Array(CaptureStep)),
  }),
  review: Schema.Struct({
    /** `"none"` is a repo with no review bot: its rounds turn on the checks alone. */
    provider: Schema.Literals(["cubic", "none"]),
    requireScore: Schema.Number,
    maxRounds: Schema.Number,
    timeoutMinutes: Schema.Number,
  }),
  /** How long to wait for the PR's checks after a push; defaults to the review timeout. */
  checks: Schema.optional(Schema.Struct({ timeoutMinutes: Schema.Number })),
  /**
   * Hold the machine awake for the length of a run, so a laptop that suspends
   * does not take every open wait with it. macOS only (`caffeinate`), and off
   * unless asked for: this file is committed, so it is one machine's
   * preference living in every contributor's checkout.
   */
  keepAwake: Schema.optional(Schema.Boolean),
  /**
   * Post the run's outcome to Notification Center when it ends, however it
   * ends, through a bundle built once per machine so the notification carries
   * fabrika's own name and icon. macOS only, and off unless asked for, for the
   * same reason as `keepAwake`: this file is committed.
   */
  notify: Schema.optional(Schema.Boolean),
  maxIterations: Schema.Number,
});
export type Config = typeof Config.Type;

/**
 * The two halves of `base`. It is written the way git writes a remote-tracking
 * ref, `origin/main`, and a bare `main` means the default remote — so the
 * remote is the first segment and everything after it is the branch, which may
 * carry slashes of its own.
 */
export const remoteOf = (base: string) => (base.includes("/") ? base.split("/")[0]! : "origin");
export const baseBranch = (base: string) => (base.includes("/") ? base.slice(base.indexOf("/") + 1) : base);

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
  // `capture` is present so `init` keeps the key in this position; `JSON.stringify` drops it.
  pr: { draft: true, emptyCommit: true, capture: undefined },
  // What `init` writes when its configure call is rejected, and a fallback that escalates by construction is not a fallback.
  review: { provider: "none", requireScore: 5, maxRounds: 3, timeoutMinutes: 25 },
  checks: { timeoutMinutes: 30 },
  maxIterations: 4,
};
