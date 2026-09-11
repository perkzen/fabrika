import { Effect, FileSystem } from "effect";
import { fileURLToPath } from "node:url";
import { runClaude, type Credential } from "./claude.ts";
import { CONFIG_TEMPLATE, type GateStep } from "./config.ts";

/** The three repo-specific fields of `.fabrika/config.json`, plus what the call wants recorded. */
export type ConfigProposal = {
  readonly base: string;
  readonly install: string | undefined;
  readonly gate: ReadonlyArray<GateStep>;
  readonly notes: ReadonlyArray<string>;
};

export const CONFIG_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    base: { type: "string", description: "The branch PRs target, as a remote ref, e.g. origin/main" },
    install: { type: "string", description: "Command that installs dependencies from the lockfile; omit if the repo needs none" },
    gate: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          run: { type: "string" },
          when: { type: "array", items: { type: "string" }, description: "Globs; the step runs only when a changed file matches" },
        },
        required: ["name", "run"],
      },
    },
    notes: {
      type: "array",
      items: { type: "string" },
      description: "One line per decision: where each step came from, what was verified, what a human should check",
    },
  },
  required: ["base", "gate", "notes"],
});

/**
 * The config denies the agent `git push`, `gh pr merge` and the rest, because
 * the host owns them. A gate step is a command the host runs on the agent's
 * say-so every stage, so it is the one place that rule could be laundered
 * back in — the answer is rejected rather than trusted.
 */
const FORBIDDEN = /\bgit\s+push\b|\bgh\s+pr\s+(?:merge|review)\b|\b(?:npm|pnpm|yarn|bun)\s+publish\b|\brm\s+-[rf]/;

const isStep = (raw: unknown): raw is GateStep => {
  const s = raw as Partial<GateStep> | undefined;
  if (!s || typeof s.name !== "string" || typeof s.run !== "string") return false;
  if (!/^[a-z0-9]+(?:[-:][a-z0-9]+)*$/.test(s.name) || s.name.length > 40) return false;
  if (!s.run.trim() || s.run.length > 300 || FORBIDDEN.test(s.run)) return false;
  return s.when === undefined || (Array.isArray(s.when) && s.when.every((g) => typeof g === "string"));
};

/** Accepts the answer only if every part of it is usable; a partial one is not merged. */
export const asProposal = (raw: unknown): ConfigProposal | null => {
  const r = raw as Partial<ConfigProposal> | undefined;
  if (!r || typeof r.base !== "string" || !/^[\w.\-]+\/[\w.\-\/]+$/.test(r.base)) return null;
  if (r.install !== undefined && (typeof r.install !== "string" || !r.install.trim() || FORBIDDEN.test(r.install))) return null;
  if (!Array.isArray(r.gate) || !r.gate.every(isStep)) return null;
  const notes = Array.isArray(r.notes) ? r.notes.filter((n): n is string => typeof n === "string") : [];
  return { base: r.base, install: r.install, gate: r.gate, notes };
};

const PROMPT = fileURLToPath(new URL("../prompts/configure.md", import.meta.url));

/**
 * One structured call at `init`, applying `fabrika:configure`. The gate is the
 * repo's own checks, so it has to be read off the repo rather than shipped;
 * the call runs the candidates before proposing them, which is the part a
 * template cannot do.
 */
export const proposeConfig = (repoRoot: string, credential: Credential, onLine: (line: string) => void) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const prompt = yield* fs.readFileString(PROMPT);
    // The same rules every stage runs under: this call reads and runs checks,
    // it never pushes or merges.
    const result = yield* runClaude({
      cwd: repoRoot,
      prompt,
      credential,
      jsonSchema: CONFIG_SCHEMA,
      disallowedTools: CONFIG_TEMPLATE.deny,
      onLine,
    });
    return asProposal(result.structured);
  });
