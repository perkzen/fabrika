import { Effect, FileSystem } from "effect";
import { fileURLToPath } from "node:url";
import { runClaude, type Credential } from "./infra/claude.ts";
import { CONFIG_TEMPLATE, FORBIDDEN, type CaptureStep, type Config, type GateStep } from "./config.ts";
import type { RunEvent } from "./domain/run-event.ts";

/** The repo-specific fields of `.fabrika/config.json`, plus what the call wants recorded. */
export type ConfigProposal = {
  readonly base: string;
  readonly install: string | undefined;
  readonly gate: ReadonlyArray<GateStep>;
  readonly capture: ReadonlyArray<CaptureStep>;
  readonly provider: Config["review"]["provider"];
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
    capture: {
      type: "array",
      description:
        "Almost always empty: `pr.beforeAfter` is on by default and each run works its own capture out from its diff. Propose one ONLY when the render is expensive enough to be worth pinning — a simulator boot, a full site build — so it is reviewed rather than re-chosen every run",
      items: {
        type: "object",
        properties: {
          name: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", description: "Short kebab-case label for the log, e.g. console" },
          run: { type: "string" },
          when: { type: "array", items: { type: "string" }, description: "Globs; the capture runs only when a changed file matches" },
          timeoutMinutes: { type: "number", description: "Killed and its half dropped after this long; 2 when absent" },
        },
        required: ["name", "run"],
      },
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
 * Shape is normalised, not rejected. The fallback for a rejected answer is no
 * gate at all, so `Typecheck` or `e2e (chromium)` coming back from a call that
 * read the repo correctly must not cost the whole thing.
 */
const stepName = (raw: unknown): string =>
  (typeof raw === "string" ? raw : "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    // Trimmed after the cut, not before: a 41st character makes the cut land
    // on a hyphen, and a capture name with one on the end is a config the
    // schema will not load.
    .replace(/^-+|-+$/g, "") || "check";

/** Names only reach the log and the escalation line, but two `check` steps there would be unreadable. */
const unique = <S extends { readonly name: string }>(steps: ReadonlyArray<S>): Array<S> => {
  const out: Array<S> = [];
  for (const step of steps) {
    let name = step.name;
    for (let n = 2; out.some((seen) => seen.name === name); n++) name = `${step.name}-${n}`;
    out.push({ ...step, name });
  }
  return out;
};

const asStep = (raw: unknown): GateStep | null => {
  const s = raw as Partial<GateStep> | undefined;
  if (!s || typeof s.run !== "string" || !s.run.trim() || s.run.length > 300 || FORBIDDEN.test(s.run)) return null;
  if (s.when !== undefined && (!Array.isArray(s.when) || !s.when.every((g) => typeof g === "string"))) return null;
  const step = { name: stepName(s.name), run: s.run.trim() };
  return s.when ? { ...step, when: s.when } : step;
};

/** A capture is a gate step the host runs for evidence rather than for a verdict, so it takes the same path plus a timeout. */
const asCapture = (raw: unknown): CaptureStep | null => {
  const step = asStep(raw);
  if (!step) return null;
  const minutes = (raw as Partial<CaptureStep> | undefined)?.timeoutMinutes;
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? { ...step, timeoutMinutes: minutes } : step;
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
    gate.push(step);
  }
  if (r.capture !== undefined && !Array.isArray(r.capture)) return null;
  const capture: Array<CaptureStep> = [];
  for (const entry of r.capture ?? []) {
    const step = asCapture(entry);
    if (!step) return null;
    capture.push(step);
  }
  const notes = Array.isArray(r.notes) ? r.notes.filter((n): n is string => typeof n === "string") : [];
  // Normalised like `stepName`: a wrong `"none"` loses a signal the human still sees on the PR, where a wrong `"cubic"` guarantees an escalation.
  const provider = r.provider === "cubic" ? "cubic" : "none";
  return { base, install: r.install, gate: unique(gate), capture: unique(capture), provider, notes };
};

/**
 * What `init` writes, from what the call proposed — or the neutral template
 * when nothing usable came back, because `init` has a config to write either
 * way. It lives beside `asProposal` that produced its input: the proposal's
 * fields are declared, validated and applied in one place, so a fifth one is
 * added here rather than in a merge the CLI keeps on the side.
 *
 * `review` and `pr` are spread, not replaced — the call proposes one field of
 * each and the rest are the template's.
 */
export const asConfig = (proposal: ConfigProposal | null): Config =>
  proposal
    ? {
        ...CONFIG_TEMPLATE,
        base: proposal.base,
        install: proposal.install,
        gate: proposal.gate,
        pr: { ...CONFIG_TEMPLATE.pr, capture: proposal.capture.length > 0 ? proposal.capture : undefined },
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
