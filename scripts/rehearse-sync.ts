import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as fileJournal from "../src/adapters/file-journal.ts";
import { banner, VERSION } from "../src/terminal/banner.ts";
import { sweep, type Placement } from "../src/pipeline/sweep.ts";
import type { SyncTarget } from "../src/pipeline/sweep-selection.ts";
import { syncPullRequest } from "../src/pipeline/sync-worker.ts";
import { Agent, type AgentRequest } from "../src/ports/agent.ts";
import type { PullRequestDetail } from "../src/ports/forge.ts";
import { Gate } from "../src/ports/gate.ts";
import { Journal, waitFor } from "../src/ports/journal.ts";
import { Workspace } from "../src/ports/workspace.ts";
import { harness } from "../test/harness.ts";

/**
 * A sweep on a stage set.
 *
 * The rehearsal `rehearse.ts` is for a run, one command over: the real
 * selection, the real fan-out, the real journal surface and the rows it hands
 * out, and the real `syncPullRequest` in each of them — over the harness's
 * in-memory ports, with a scripted agent and timed merges. No `git`, no `gh`,
 * no `claude`, no `~/.fabrika`.
 *
 * It exists because a sweep's screen is the one surface no test can show you:
 * the tests drive the frame with a scripted event list and assert on rows,
 * where what an operator wants to know is whether six workers writing at once
 * is something a person can read.
 *
 *   pnpm rehearse:sync          # about a minute, paced like a sweep
 *   pnpm rehearse:sync --fast   # the same sweep in a few seconds
 *
 * Six pull requests: two the agent resolves and pushes, one whose base had not
 * moved after all, one it cannot finish resolving, and two the rules skip for
 * two different reasons — which is one of every row a sweep can draw.
 */

/** An open, conflicted pull request on the base; each case says how it differs. */
const pullRequest = (over: Partial<PullRequestDetail> & { readonly number: number }): PullRequestDetail => ({
  url: `https://github.com/perkzen/fabrika/pull/${over.number}`,
  title: "fix: a thing",
  body: "a description",
  branch: `perkzen/fix/pr-${over.number}`,
  base: "main",
  state: "open",
  draft: true,
  fork: false,
  merge: "conflicted",
  ...over,
});

const TRAILER = "---\nOpened by fabrika. Draft until a human reviews.";

const PULL_REQUESTS: ReadonlyArray<PullRequestDetail> = [
  pullRequest({ number: 42, title: "FAB-5: Conflicted PRs pile up", body: TRAILER, branch: "perkzen/feat/FAB-5/sweep" }),
  pullRequest({ number: 41, title: "FAB-7: A stage says which model runs it", body: TRAILER, branch: "perkzen/feat/FAB-7/per-stage-model" }),
  // The two skipped rows, each by a different rule, so the screen shows what
  // a dimmed row's detail is for.
  pullRequest({ number: 40, title: "chore: bump the lockfile", merge: "behind" }),
  pullRequest({ number: 39, title: "FAB-9: The outline holds more than one wait", body: TRAILER, branch: "perkzen/fix/FAB-9/waits" }),
  // Conflicted when GitHub was asked; the base had not moved by the time the
  // worker got to it, which is the `already clean` outcome.
  pullRequest({ number: 38, title: "fix: the capture cache keys on the base", branch: "perkzen/fix/capture-cache" }),
  pullRequest({ number: 37, title: "FAB-3: The select is one flow", body: TRAILER, branch: "perkzen/feat/FAB-3/select" }),
];

/** What one worker does, and how long each part of it is on screen for. */
type Scene = {
  /** What `mergeBase` answers, and so which of the three shapes the row takes. */
  readonly merge: "conflicted" | "clean" | "up-to-date";
  /** Files the agent is asked to resolve, and the ones it leaves behind. */
  readonly files: ReadonlyArray<string>;
  readonly unresolved?: ReadonlyArray<string>;
  readonly behind: number;
  /** What the agent says while it resolves, in the order it says it. */
  readonly beats: ReadonlyArray<readonly [ms: number, say: string]>;
};

const SCENES: Record<string, Scene> = {
  "FAB-5-42": {
    merge: "conflicted",
    behind: 12,
    files: ["src/pipeline/sweep.ts", "src/domain/outline.ts"],
    beats: [
      [1400, "Two conflicts, both in code the base rewrote:\n\n- `src/pipeline/sweep.ts` — the fan-out gained a `run` event\n- `src/domain/outline.ts` — waits moved onto the node"],
      [2600, "Taking the base's shape for both and re-applying this branch's change on top of it."],
      [1800, "Resolved. The gate will say whether I was right."],
    ],
  },
  "FAB-7-41": {
    merge: "conflicted",
    behind: 12,
    files: ["src/config.ts"],
    beats: [
      [1200, "One conflict in `src/config.ts`: the base added `model` to the stage schema and so did this branch."],
      [2400, "Same field, same type, different comment — keeping the base's wording and this branch's default."],
    ],
  },
  "FAB-9-39": {
    merge: "conflicted",
    behind: 12,
    files: ["src/domain/outline.ts", "src/terminal/frame.ts", "src/terminal/screen.ts"],
    unresolved: ["src/terminal/frame.ts"],
    beats: [
      [1500, "Three conflicts. `src/domain/outline.ts` and `src/terminal/screen.ts` are mechanical."],
      [2800, "`src/terminal/frame.ts` is not: the base moved the liveness row onto the node and this branch made it a list. Both are right and I cannot tell which the author meant — leaving it for a human."],
    ],
  },
  "pr-38": { merge: "up-to-date", behind: 0, files: [], beats: [] },
};

const sceneFor = (key: string): Scene => SCENES[key] ?? { merge: "clean", behind: 3, files: [], beats: [] };

/** The gate a sweep runs after the merge, and how long each command is on screen for. */
const GATE = [
  { name: "compile", run: "pnpm compile", ms: 2200 },
  { name: "test", run: "pnpm test", ms: 3400 },
] as const;

export type RehearsalOptions = {
  readonly stream: NodeJS.WriteStream;
  readonly input?: NodeJS.ReadStream;
  /** Multiplies every pause. `1` is paced like a sweep; `0` waits for nothing, for a test. */
  readonly speed: number;
  readonly concurrency?: number;
  /** Where the workers' `log.txt` files go; a temp directory by default. */
  readonly dir?: string;
};

/**
 * The sweep, assembled the way `src/sweep.ts` assembles the real one: one
 * surface for the whole sweep, and per worker a journal that is its own
 * archive plus the row that surface handed out.
 *
 * The overrides are the three ports a rehearsal wants to behave differently —
 * an agent with a script, a gate with a clock, and a workspace whose merge and
 * install take the time theirs do. Everything between them is the shipped
 * code.
 */
export const rehearseSweep = (options: RehearsalOptions) =>
  Effect.gen(function* () {
    const pause = (ms: number) => Effect.sleep(ms * options.speed);
    const dir = options.dir ?? mkdtempSync(join(tmpdir(), "fabrika-sweep-rehearsal-"));

    const surface = fileJournal.sweep({
      label: "perkzen/fabrika",
      stream: options.stream,
      input: options.input,
      // A rehearsal of a key can honestly say what the key would have done;
      // it opens nothing. Through the sweep's own journal, so it lands in
      // scrollback under the screen rather than over it.
      open: (worktree) => say?.(`o: a sweep would open ${worktree} in the editor; a rehearsal opens nothing`),
    });
    let say: ((entry: string) => void) | undefined;

    // The discovery side: the pull requests to sweep, and the one branch this
    // machine already has a worktree on, which is the rule that fences #37.
    const discovery = harness({
      pullRequests: PULL_REQUESTS,
      checkedOut: [{ branch: "perkzen/feat/FAB-3/select", path: join(homedir(), "dev", "fabrika") }],
    });

    const place = (target: SyncTarget): Effect.Effect<Placement> =>
      Effect.succeed({
        // Where a real sweep would put the tree, so the row's detail and the
        // `o` key read as they would; nothing is ever created there.
        worktree: join(homedir(), ".fabrika", "worktrees", "fabrika", target.key),
        log: join(dir, `${target.key}.log.txt`),
      });

    const worker = (target: SyncTarget, placement: Placement) => {
      const scene = sceneFor(target.key);
      const world = harness({
        dir: placement.worktree,
        // A believable tip, so the pushed sha the row reports reads like one.
        remoteTip: "9f1c2ab3d4e5f6a7b8",
        merge:
          scene.merge === "up-to-date"
            ? [{ _tag: "UpToDate" }]
            : scene.merge === "clean"
              ? [{ _tag: "Merged", behind: scene.behind }]
              : [{ _tag: "Conflicted", behind: scene.behind, files: [...scene.files] }],
        unresolved: [...(scene.unresolved ?? [])],
      });
      // The row is this worker's address on the sweep's surface, exactly as
      // `src/sweep.ts` resolves it.
      const journal = fileJournal.archiveOnly(placement.log, [surface.row(target.key, placement.worktree)]);
      const base = Layer.merge(world.layer, journal);
      const overrides = Layer.mergeAll(agent(scene, pause), gate(pause), workspace(pause)).pipe(Layer.provide(base));
      return syncPullRequest({ ...target, install: "pnpm install --frozen-lockfile" }).pipe(
        Effect.provide(Layer.merge(base, overrides)),
      );
    };

    const fan = sweep({
      base: "origin/main",
      concurrency: options.concurrency ?? 2,
      dryRun: false,
      place,
      worker,
    });

    // The sweep's own journal to the right of the harness's recording one, so
    // the surface above is the one every line of the fan-out reaches.
    return yield* Effect.gen(function* () {
      say = (yield* Journal).write;
      const result = yield* fan;
      return { dir, ...result };
    }).pipe(Effect.provide(Layer.merge(discovery.layer, surface.layer)));
  });

/** The agent that resolves this worker's conflicts, one beat at a time. */
const agent = (scene: Scene, pause: (ms: number) => Effect.Effect<void>) =>
  Layer.effect(Agent)(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return {
        ensureTools: () => Effect.void,
        ask: (request: AgentRequest) =>
          Effect.gen(function* () {
            yield* Effect.gen(function* () {
              yield* journal.log({ kind: "note", level: "detail", text: "[credential] default" });
              for (const file of scene.files) {
                yield* pause(700);
                yield* journal.log({ kind: "tool", stage: request.stage, tool: "Read", subject: file });
              }
              for (const [ms, markdown] of scene.beats) {
                yield* pause(ms);
                yield* journal.log({ kind: "agent", stage: request.stage, markdown });
              }
              for (const file of scene.files) {
                if (scene.unresolved?.includes(file)) continue;
                yield* pause(900);
                yield* journal.log({ kind: "tool", stage: request.stage, tool: "Edit", subject: file });
              }
              // The merge lands as one commit, the way a resolved merge does.
              yield* pause(600);
              yield* journal.log({ kind: "tool", stage: request.stage, tool: "Bash", subject: "git add -A" });
            }).pipe(waitFor(journal, `${request.stage} agent`));
            yield* journal.log({ kind: "cost", stage: request.stage, usd: 0.4 + scene.files.length * 0.35 });
            return { text: "", structured: undefined };
          }),
      };
    }),
  );

/** The gate the merge runs up to, green, with the clock a real one takes. */
const gate = (pause: (ms: number) => Effect.Effect<void>) =>
  Layer.effect(Gate)(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return {
        feedback: (failure) => `gate ${failure.name} failed:\n${failure.output}`,
        check: Effect.gen(function* () {
          for (const [index, step] of GATE.entries()) {
            const event = { kind: "gate", name: step.name, at: index + 1, of: GATE.length, command: step.run } as const;
            yield* journal.log({ ...event, state: "start" });
            const started = Date.now();
            yield* pause(step.ms);
            // Timed rather than scripted, the way `shell-gate` times it, so
            // `--fast` says `0s` and never claims a wait it did not make.
            yield* journal.log({ ...event, state: "pass", seconds: Math.round((Date.now() - started) / 1000) });
          }
          return undefined;
        }),
      };
    }),
  );

/**
 * The tree, with the two things that actually take a while taking it: the
 * install and the merge. Everything else is the harness's own fake.
 */
const workspace = (pause: (ms: number) => Effect.Effect<void>) =>
  Layer.effect(Workspace)(
    Effect.gen(function* () {
      const inner = yield* Workspace;
      return {
        ...inner,
        checkout: (branch: string) => pause(1600).pipe(Effect.andThen(inner.checkout(branch))),
        install: (command: string) => pause(4200).pipe(Effect.andThen(inner.install(command))),
        mergeBase: pause(1200).pipe(Effect.andThen(inner.mergeBase)),
        push: (branch: string) => pause(900).pipe(Effect.andThen(inner.push(branch))),
      };
    }),
  );

const main = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (main) {
  const fast = process.argv.includes("--fast");
  // The two things `fabrika sync` does before the fan-out, in the same order:
  // the nameplate, and then the sweep. There is no select — a sweep decides
  // what it touches by its rules, and has nothing to ask.
  banner({ stream: process.stdout, version: VERSION });
  rehearseSweep({ stream: process.stdout, input: process.stdin, speed: fast ? 0.06 : 1 })
    .pipe(
      Effect.tap(({ dir }) => Effect.sync(() => console.log(`rehearsal logs: ${dir}`))),
      Effect.provide(NodeServices.layer),
    )
    .pipe(NodeRuntime.runMain);
}
