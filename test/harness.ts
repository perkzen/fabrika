import { Effect, Layer } from "effect";
import { noReviewer } from "../src/adapters/no-reviewer.ts";
import type { Shot } from "../src/captures.ts";
import type { Config } from "../src/config.ts";
import { FabrikaError } from "../src/errors.ts";
import { CONFIG_TEMPLATE } from "../src/config.ts";
import type { StepServices } from "../src/pipeline/step.ts";
import { Agent, type AgentReply, type AgentRequest } from "../src/ports/agent.ts";
import { Captures } from "../src/ports/captures.ts";
import { Forge, type Check } from "../src/ports/forge.ts";
import { Gate, type GateFailure } from "../src/ports/gate.ts";
import { Journal } from "../src/ports/journal.ts";
import { Prompts } from "../src/ports/prompts.ts";
import { Reviewer, type Review } from "../src/ports/reviewer.ts";
import { RunContext } from "../src/ports/run-context.ts";
import { RunStore, type RunState } from "../src/ports/run-store.ts";
import { Workspace, type MergeOutcome } from "../src/ports/workspace.ts";
import { plain, type RunEvent } from "../src/run-event.ts";
import type { Ticket } from "../src/ticket.ts";

/**
 * Every port, in memory.
 *
 * This is the second adapter each seam needed to be a seam at all: the steps
 * are exercised here exactly as they run in production — same interfaces,
 * same order — with no git repository, no GitHub, and no agent. What a test
 * asserts on is what a step did through those interfaces, so a test survives
 * any change that leaves the behaviour alone.
 */
export type Script = {
  /** Answered in order; the last one repeats. `undefined` is a green gate. */
  readonly gate?: ReadonlyArray<GateFailure | undefined>;
  readonly reviews?: ReadonlyArray<Review | undefined>;
  /** Swaps the shipped no-reviewer adapter in for the scripted fake. */
  readonly reviewer?: "none";
  readonly checks?: ReadonlyArray<ReadonlyArray<Check> | undefined>;
  /** What `Captures.take` answers; the fake still records what it was asked for. */
  readonly captures?: ReadonlyArray<Shot>;
  /** False for a `gh` too old to upload an image. */
  readonly attaches?: boolean;
  /** A forge that rejects the upload, or one that will not open a pull request at all. */
  readonly open?: "fails-with-attachments" | "fails";
  readonly agent?: (request: AgentRequest) => AgentReply;
  readonly merge?: ReadonlyArray<MergeOutcome>;
  /** Files reported as touched since a given sha. */
  readonly touched?: ReadonlyArray<string>;
  readonly commits?: number;
  readonly worktreeExists?: boolean;
  /** Where a real adapter would spawn commands; the fakes never touch it. */
  readonly dir?: string;
  readonly config?: Partial<Config>;
  readonly ticket?: Partial<Ticket>;
  readonly state?: Partial<RunState>;
};

export type Recording = {
  /** The plain rendering, one entry per physical line — the text an operator reads. */
  readonly log: Array<string>;
  /** The entries themselves, for the counts and flags no plain line carries. */
  readonly events: Array<RunEvent | string>;
  readonly agent: Array<AgentRequest>;
  readonly committed: Array<string>;
  readonly pushed: Array<string>;
  readonly replied: Array<{ thread: string; body: string }>;
  readonly resolved: Array<string>;
  readonly rerun: Array<string>;
  /** Every pull request the forge was asked to open, including an attempt it then rejected. */
  readonly prs: Array<{ title: string; draft: boolean; body: string; attachments: ReadonlyArray<string> }>;
  /** One entry per capture asked for, so "no command ran" is assertable as "was never asked". */
  readonly captures: Array<{ name: string; sha: string }>;
  readonly edited: Array<string>;
  readonly removed: Array<string>;
  readonly state: () => RunState;
};

const emptyState = (): RunState => ({
  sessions: {},
  branch: null,
  type: null,
  completed: [],
  prNumber: null,
  round: 0,
  pushed: [],
  reran: [],
  done: false,
});

/** The base every run in the harness is diffed against. */
export const BASE_SHA = "a1b2c3d4e5f6";

/** Answers each call in turn and then repeats its last answer forever. */
const queue = <A>(values: ReadonlyArray<A>, fallback: A) => {
  let at = 0;
  return () => {
    const value = values.length === 0 ? fallback : values[Math.min(at, values.length - 1)]!;
    at += 1;
    return value;
  };
};

export const harness = (script: Script = {}) => {
  const recording: Recording = {
    log: [],
    events: [],
    agent: [],
    committed: [],
    pushed: [],
    replied: [],
    resolved: [],
    rerun: [],
    prs: [],
    captures: [],
    edited: [],
    removed: [],
    state: () => state,
  };

  const state: RunState = { ...emptyState(), ...script.state, sessions: { ...script.state?.sessions } };
  const ticket: Ticket = {
    identifier: "FAB-1",
    title: "Add a thing",
    description: "the description",
    type: "feat",
    ...script.ticket,
  };
  const config: Config = { ...CONFIG_TEMPLATE, install: undefined, gate: [{ name: "compile", run: "true" }], ...script.config };

  const nextGate = queue(script.gate ?? [], undefined);
  const nextReview = queue(script.reviews ?? [], undefined);
  const nextChecks = queue<ReadonlyArray<Check> | undefined>(script.checks ?? [], []);
  const nextMerge = queue<MergeOutcome>(script.merge ?? [], { _tag: "UpToDate" });

  /** Moves on every commit and push, so "did HEAD change?" is answerable. */
  let head = "sha0";
  let heads = 0;
  const moveHead = () => {
    heads += 1;
    head = `sha${heads}`;
  };

  /** Both renderings at once: the lines a test asserts on, and the events behind them. */
  const record = (entry: RunEvent | string) => {
    recording.events.push(entry);
    for (const line of plain(entry)) recording.log.push(line);
  };

  const layer = Layer.mergeAll(
    Layer.succeed(Journal)({
      log: (entry: RunEvent | string) => Effect.sync(() => record(entry)),
      write: record,
    }),
    Layer.succeed(RunStore)({
      directory: "/runs/FAB-1",
      get: () => state,
      archive: () => Effect.succeed(undefined),
      update: (change: (state: RunState) => void) => Effect.sync(() => change(state)),
    }),
    Layer.succeed(RunContext)({ ticket, config }),
    Layer.succeed(Prompts)({
      render: (file: string, extra: Record<string, string> = {}) =>
        Effect.succeed(`<${file}${Object.entries(extra).map(([k, v]) => ` ${k}=${v}`).join("")}>`),
      file: (name: string) => `/prompts/${name}`,
      exists: () => Effect.succeed(true),
      define: () => {},
    }),
    Layer.succeed(Agent)({
      ask: (request: AgentRequest) =>
        Effect.sync(() => {
          recording.agent.push(request);
          return script.agent?.(request) ?? { text: "", structured: undefined };
        }),
      ensureTools: () => Effect.void,
    }),
    Layer.succeed(Captures)({
      take: (captures, baseSha) =>
        Effect.sync(() => {
          for (const capture of captures) recording.captures.push({ name: capture.name, sha: baseSha });
          return script.captures ?? [];
        }),
    }),
    Layer.succeed(Gate)({
      check: Effect.sync(nextGate),
      feedback: (failure: GateFailure) => `gate ${failure.name} failed`,
    }),
    Layer.succeed(Workspace)({
      dir: script.dir ?? "/worktree",
      repoRoot: "/repo",
      artifactsDir: "/worktree/.fabrika/work",
      readArtifact: () => Effect.succeed(undefined),
      exists: Effect.succeed(script.worktreeExists ?? false),
      currentBranch: Effect.succeed("existing/branch"),
      user: Effect.succeed("domen-perko"),
      githubRepo: Effect.succeed("perkzen/fabrika"),
      create: () => Effect.void,
      install: () => Effect.succeed(true),
      remove: Effect.sync(() => void recording.removed.push("/worktree")),
      commitAll: (message: string) => Effect.sync(() => (recording.committed.push(message), moveHead(), true)),
      emptyCommit: (message: string) => Effect.sync(() => (recording.committed.push(message), moveHead())),
      head: Effect.sync(() => head),
      baseSha: Effect.succeed(BASE_SHA),
      commitCount: Effect.succeed(script.commits ?? 1),
      changedFiles: Effect.succeed(["src/a.ts"]),
      filesSince: () => Effect.succeed(script.touched ?? []),
      mergeBase: Effect.sync(nextMerge),
      conflictedFiles: Effect.succeed([]),
      finishMerge: Effect.succeed(false),
      push: (branch: string) => Effect.sync(() => void recording.pushed.push(branch)),
    }),
    Layer.succeed(Forge)({
      repo: "perkzen/fabrika",
      urlOf: (pr: number) => `https://github.com/perkzen/fabrika/pull/${pr}`,
      open: (input) =>
        Effect.suspend(() => {
          recording.prs.push({
            title: input.title,
            draft: input.draft,
            body: input.body,
            attachments: input.attachments,
          });
          const rejects = script.open === "fails" || (script.open === "fails-with-attachments" && input.attachments.length > 0);
          return rejects
            ? Effect.fail(new FabrikaError({ message: "gh pr create: attachment rejected" }))
            : Effect.succeed({ number: 7, url: "https://github.com/perkzen/fabrika/pull/7" });
        }),
      attaches: Effect.succeed(script.attaches ?? true),
      // What `gh` actually does with an attachment: the host path in the body
      // becomes the uploaded asset's URL. A default that skipped the rewrite
      // would trip the step's read-back on every happy path.
      body: () =>
        Effect.succeed(
          (recording.prs.at(-1)?.attachments ?? []).reduce(
            (body, path, index) => body.split(path).join(`https://github.com/user-attachments/assets/${index}`),
            recording.prs.at(-1)?.body ?? "",
          ),
        ),
      editBody: (_pr: number, body: string) => Effect.sync(() => void recording.edited.push(body)),
      settledChecks: () => Effect.sync(nextChecks),
      failureLog: () => Effect.succeed("the failing log"),
      rerun: (check: Check) => Effect.sync(() => void recording.rerun.push(check.job!.id)),
    }),
    // The shipped adapter, not the fake with a flag flipped: it pins the behaviour, not the double.
    script.reviewer === "none"
      ? Layer.succeed(Reviewer)(noReviewer)
      : Layer.succeed(Reviewer)({
          name: "fake",
          scores: true,
          await: () => Effect.sync(nextReview),
          reply: (thread: string, body: string) => Effect.sync(() => void recording.replied.push({ thread, body })),
          resolve: (thread: string) => Effect.sync(() => void recording.resolved.push(thread)),
          owns: (name: string) => /fake/i.test(name),
          renderThreads: (threads) => threads.map((thread) => thread.id).join(","),
          decisionSchema: "{}",
          prompts: { threads: "threads.md", system: "threads.system.md" },
        }),
  );

  return { layer: layer as Layer.Layer<StepServices>, recording, state, config, ticket };
};

/** Runs a step (or any step effect) against the fakes and returns the recording. */
export const exercise = <A, E>(
  effect: Effect.Effect<A, E, StepServices>,
  script: Script = {},
): Promise<{ exit: A | E; failed: boolean; recording: Recording }> => {
  const world = harness(script);
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(world.layer),
      Effect.match({
        onSuccess: (value) => ({ exit: value as A | E, failed: false, recording: world.recording }),
        onFailure: (error) => ({ exit: error as A | E, failed: true, recording: world.recording }),
      }),
    ),
  );
};
