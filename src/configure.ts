import { Effect, FileSystem } from "effect";
import { fileURLToPath } from "node:url";
import { runClaude, type Credential } from "./infra/claude.ts";
import { CONFIG_TEMPLATE, DEFAULT_SOURCE, type Config, type GateStep } from "./config.ts";
import type { RunEvent } from "./run-event.ts";

/** The five repo-specific fields of `.fabrika/config.json`, plus what the call wants recorded. */
export type ConfigProposal = {
  readonly base: string;
  readonly install: string | undefined;
  readonly gate: ReadonlyArray<GateStep>;
  readonly provider: Config["review"]["provider"];
  /** Where this repo's own source lives, as globs; never empty. */
  readonly source: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
};

export const CONFIG_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    base: { type: "string", pattern: "^[\\w.-]+/[\\w./-]+$", description: "The branch PRs target, as a remote ref, e.g. origin/main" },
    install: { type: "string", description: "Command that installs dependencies from the lockfile; omit if the repo needs none" },
    gate: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", description: "Short kebab-case label for the log, e.g. compile" },
          run: { type: "string" },
          when: { type: "array", items: { type: "string" }, description: "Globs; the step runs only when a changed file matches" },
        },
        required: ["name", "run"],
      },
    },
    source: {
      type: "array",
      items: { type: "string" },
      description:
        "Globs naming where this repo's own source lives — the tree whose change makes an architecture pass worth paying for, e.g. src/** or packages/*/src/**; leave tests, docs, fixtures and generated output out",
    },
    provider: {
      type: "string",
      enum: ["cubic", "none"],
      description:
        "The review bot this repo already has, as evidence off its own pull requests: cubic when a review by cubic-dev-ai[bot] is there, none otherwise",
    },
    notes: {
      type: "array",
      items: { type: "string" },
      description: "One line per decision: where each step came from, what was verified, what a human should check",
    },
  },
  required: ["base", "gate", "provider", "notes"],
});

/**
 * The config denies the agent `git push`, `gh pr merge` and the rest, because
 * the host owns them. A gate step is a command the host runs on the agent's
 * say-so every stage, so it is the one place that rule could be laundered
 * back in — one of these anywhere in the answer rejects the whole answer.
 * `rm -rf dist` is an ordinary clean-build step and stays allowed; only a path
 * outside the worktree is not.
 */
const FORBIDDEN = /\bgit\s+push\b|\bgh\s+pr\s+(?:merge|review)\b|\b(?:npm|pnpm|yarn|bun)\s+publish\b|\brm\s+-[rf]+\s+(?:\/|~)/;

/**
 * A glob names no command, so it gets no `FORBIDDEN` check — only a bound,
 * because a path glob longer than this is not a path glob.
 */
const sourceGlobs = (raw: unknown): ReadonlyArray<string> => {
  const globs = Array.isArray(raw)
    ? raw.filter((g): g is string => typeof g === "string").map((g) => g.trim()).filter((g) => g && g.length <= 200)
    : [];
  // Rejecting the whole answer over this field would cost the gate, which is
  // the expensive part of the call; the template's own default stands in.
  return globs.length > 0 ? globs : DEFAULT_SOURCE;
};

/**
 * Shape is normalised, not rejected. The fallback for a rejected answer is no
 * gate at all, so `Typecheck` or `e2e (chromium)` coming back from a call that
 * read the repo correctly must not cost the whole thing.
 */
const stepName = (raw: unknown): string =>
  (typeof raw === "string" ? raw : "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "check";

const asStep = (raw: unknown): GateStep | null => {
  const s = raw as Partial<GateStep> | undefined;
  if (!s || typeof s.run !== "string" || !s.run.trim() || s.run.length > 300 || FORBIDDEN.test(s.run)) return null;
  if (s.when !== undefined && (!Array.isArray(s.when) || !s.when.every((g) => typeof g === "string"))) return null;
  const step = { name: stepName(s.name), run: s.run.trim() };
  return s.when ? { ...step, when: s.when } : step;
};

/** Accepts the answer only if every part of it is usable; a partial one is not merged. */
export const asProposal = (raw: unknown): ConfigProposal | null => {
  const r = raw as Partial<ConfigProposal> | undefined;
  if (!r || typeof r.base !== "string" || !r.base.trim()) return null;
  // A bare branch name is the likely near-miss, and the remote is not a guess.
  const base = r.base.trim().includes("/") ? r.base.trim() : `origin/${r.base.trim()}`;
  if (!/^[\w.\-]+\/[\w.\-\/]+$/.test(base)) return null;
  if (r.install !== undefined && (typeof r.install !== "string" || !r.install.trim() || FORBIDDEN.test(r.install))) return null;
  if (!Array.isArray(r.gate)) return null;
  const gate: Array<GateStep> = [];
  for (const entry of r.gate) {
    const step = asStep(entry);
    if (!step) return null;
    // Names only reach the log and the escalation line, but two `check` steps
    // there would be unreadable.
    let name = step.name;
    for (let n = 2; gate.some((g) => g.name === name); n++) name = `${step.name}-${n}`;
    gate.push({ ...step, name });
  }
  const notes = Array.isArray(r.notes) ? r.notes.filter((n): n is string => typeof n === "string") : [];
  // Normalised like `stepName`: a wrong `"none"` loses a signal the human still sees on the PR, where a wrong `"cubic"` guarantees an escalation.
  const provider = r.provider === "cubic" ? "cubic" : "none";
  return { base, install: r.install, gate, provider, source: sourceGlobs(r.source), notes };
};

/**
 * What `init` writes, from what the call proposed — or the neutral template
 * when nothing usable came back, because `init` has a config to write either
 * way. It lives beside `asProposal` that produced its input: the proposal's
 * fields are declared, validated and applied in one place, so a fifth one is
 * added here rather than in a merge the CLI keeps on the side.
 *
 * `review` is spread, not replaced — the call proposes one of its four fields
 * and the other three are the template's.
 */
export const asConfig = (proposal: ConfigProposal | null): Config =>
  proposal
    ? {
        ...CONFIG_TEMPLATE,
        base: proposal.base,
        install: proposal.install,
        gate: proposal.gate,
        review: { ...CONFIG_TEMPLATE.review, provider: proposal.provider },
      }
    : CONFIG_TEMPLATE;

const PROMPT = fileURLToPath(new URL("../prompts/configure.md", import.meta.url));

/**
 * One structured call at `init`, applying `fabrika:configure`. The gate is the
 * repo's own checks, so it has to be read off the repo rather than shipped;
 * the call runs the candidates before proposing them, which is the part a
 * template cannot do.
 */
export const proposeConfig = (repoRoot: string, credential: Credential, onEvent: (event: RunEvent) => void) =>
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
      stage: "configure",
      onEvent,
    });
    return asProposal(result.structured);
  });
