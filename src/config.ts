import { Data, Effect, FileSystem, Path, Schema } from "effect";

export const Stage = Schema.Struct({
  name: Schema.String,
  prompt: Schema.String,
  system: Schema.optional(Schema.String),
  mcp: Schema.optional(Schema.Array(Schema.String)),
  gate: Schema.optional(Schema.Boolean),
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
  branch: Schema.String,
  install: Schema.optional(Schema.String),
  gate: Schema.Array(GateStep),
  stages: Schema.Array(Stage),
  deny: Schema.Array(Schema.String),
  pr: Schema.Struct({ draft: Schema.Boolean, emptyCommit: Schema.Boolean }),
  review: Schema.Struct({
    provider: Schema.Literal("cubic"),
    requireScore: Schema.Number,
    maxRounds: Schema.Number,
    timeoutMinutes: Schema.Number,
  }),
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
 * Hand-formatted rather than JSON.stringify'd: the target repo's
 * `prettier --check .` covers this file, and prettier collapses short arrays
 * onto one line where stringify would expand them.
 */
export const CONFIG_TEMPLATE = `{
  "base": "origin/staging",
  "branch": "preview/domen/{type}/{ticket}/{slug}",
  "install": "npm ci",
  "gate": [
    { "name": "compile", "run": "npm run compile" },
    { "name": "test", "run": "npm run test" },
    { "name": "integration", "run": "npm run test:integration" },
    { "name": "knip", "run": "npm run knip" },
    { "name": "format", "run": "npm run format:check" },
    {
      "name": "desktop-compat",
      "run": "npm run check:desktop-compat",
      "when": ["apps/desktop/**", "packages/shared/**"]
    }
  ],
  "stages": [
    {
      "name": "plan",
      "prompt": "plan.md",
      "system": "plan.system.md",
      "mcp": ["linear-ro"]
    },
    {
      "name": "implement",
      "prompt": "implement.md",
      "system": "implement.system.md",
      "gate": true
    },
    {
      "name": "review",
      "prompt": "review.md",
      "system": "review.system.md",
      "gate": true
    }
  ],
  "deny": [
    "Bash(git push:*)",
    "Bash(gh pr merge:*)",
    "Bash(gh pr review:*)",
    "Bash(gh api graphql:*)"
  ],
  "pr": { "draft": true, "emptyCommit": true },
  "review": {
    "provider": "cubic",
    "requireScore": 5,
    "maxRounds": 3,
    "timeoutMinutes": 25
  },
  "maxIterations": 4
}
`;
