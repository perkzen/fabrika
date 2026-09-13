import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as fileJournal from "../src/adapters/file-journal.ts";
import type { Config } from "../src/config.ts";
import { isInteractive } from "../src/infra/console.ts";
import { openScreen } from "../src/infra/screen.ts";
import { fabrikaPipeline } from "../src/pipeline/fabrika.ts";
import { Agent, type AgentRequest } from "../src/ports/agent.ts";
import { Forge } from "../src/ports/forge.ts";
import { Gate } from "../src/ports/gate.ts";
import { Journal, waitFor } from "../src/ports/journal.ts";
import { Reviewer } from "../src/ports/reviewer.ts";
import { harness } from "../test/harness.ts";

/**
 * A rehearsal: the whole run, on a stage set.
 *
 * The real pipeline — the same steps in the same order, the real step driver,
 * the real journal fan-out, the real screen — over ports that touch nothing:
 * no `git`, no `gh`, no `claude`, no `~/.fabrika`. The agent is a script of
 * what an agent says and reaches for, the gate goes red exactly once, the
 * reviewer opens one thread and then signs off, and every wait a real run
 * has is a wait here too, only shorter. It is how the screen is looked at
 * without spending an agent bill on it, and how a change to the pipeline is
 * watched end to end before a ticket is.
 *
 *   pnpm rehearse          # about two minutes, paced like a run
 *   pnpm rehearse --fast   # the same run in a few seconds
 *
 * Every row state the outline has is on screen once: the branch call says
 * the ticket is a fix, so `refactor` — `feat` only — is skipped.
 */

/** One thing the agent does, and how long after the last one. */
type Beat = { readonly ms: number; readonly say?: string; readonly tool?: readonly [tool: string, subject: string] };

type Scene = { readonly beats: ReadonlyArray<Beat>; readonly usd: number; readonly structured?: unknown };

const skill = (name: string, ms = 400): Beat => ({ ms, tool: ["Skill", name] });
const say = (markdown: string, ms = 900): Beat => ({ ms, say: markdown });
const read = (path: string, ms = 500): Beat => ({ ms, tool: ["Read", path] });
const edit = (path: string, ms = 700): Beat => ({ ms, tool: ["Edit", path] });
const bash = (command: string, ms = 600): Beat => ({ ms, tool: ["Bash", command] });

/** What each stage's agent does, in the order a real one tends to. */
const SCENES: Record<string, Scene> = {
  branch: {
    beats: [say("I'll load the branch-naming skill first."), skill("fabrika:branch-naming"), read(".fabrika/tickets/FAB-0.md")],
    usd: 0.2,
    structured: { type: "fix", slug: "per-stage-model", preview: true },
  },
  spec: {
    beats: [
      skill("fabrika:spec"),
      say("Reading the ticket and the **stage config** before writing anything.\n\n- `src/config.ts` — where `model` would live\n- `src/infra/claude.ts` — the flag that spends it"),
      read("src/config.ts"),
      read("src/infra/claude.ts"),
      say("The field exists and nothing fills it. The spec is one sentence per stage: *a stage names its model, or inherits the run's.*", 2200),
      edit(".fabrika/work/spec.md", 1200),
    ],
    usd: 0.42,
  },
  plan: {
    beats: [
      skill("fabrika:plan"),
      read(".fabrika/work/spec.md"),
      say("Three slices, each shippable on its own:\n\n1. `model` on the stage schema\n2. the request carries it to the adapter\n3. `init` writes the default"),
      edit(".fabrika/work/plan.md", 1400),
    ],
    usd: 0.31,
  },
  implement: {
    beats: [
      skill("fabrika:tdd"),
      read(".fabrika/work/plan.md"),
      say("Slice one. The failing test first."),
      edit("test/config.test.ts", 1100),
      bash("pnpm test test/config.test.ts", 1600),
      edit("src/config.ts", 1300),
      edit("src/ports/agent.ts", 900),
      edit("src/adapters/claude-agent.ts", 1200),
      bash("pnpm test", 2400),
      say("Green. Committing slice one before the next.", 800),
      bash("git commit -am 'feat(config): a stage names its model'", 700),
    ],
    usd: 3.8,
  },
  "implement/retry": {
    beats: [
      say("The `test` gate is red: the schema test still expects `model` to be required. Making it optional, as the spec says."),
      edit("test/config.test.ts", 1100),
      bash("pnpm test", 2200),
      bash("git commit -am 'test(config): model is optional'", 600),
    ],
    usd: 0.9,
  },
  security: {
    beats: [
      skill("fabrika:security"),
      bash("git diff origin/main...HEAD --stat", 800),
      read("src/adapters/claude-agent.ts"),
      say("The model name reaches `claude --model` as one argv element, never through a shell. Nothing to flag."),
    ],
    usd: 0.6,
  },
  review: {
    beats: [
      skill("fabrika:review"),
      bash("git diff origin/main...HEAD", 900),
      say("One thing worth fixing: `model` is read in two places. Folding it into the request builder."),
      edit("src/adapters/claude-agent.ts", 1200),
      bash("pnpm test", 2200),
    ],
    usd: 0.74,
  },
  cubic: {
    beats: [
      read("src/config.ts"),
      say("The thread is right: the docs comment names the old default. Fixed."),
      edit("src/config.ts", 900),
    ],
    usd: 0.28,
    structured: { decisions: [{ threadId: "t1", action: "fixed", reply: "Fixed: the comment now names the run's default." }] },
  },
};

/** The stage's scene, or a short one for a stage the script does not know. */
const sceneFor = (request: AgentRequest, call: number): Scene => {
  if (request.stage === "implement" && call > 1) return SCENES["implement/retry"]!;
  return SCENES[request.stage] ?? { beats: [say(`Working on ${request.stage}.`)], usd: 0.1 };
};

/** The gate, as the config would name it, and how long each command is on screen for. */
const GATE = [
  { name: "compile", run: "pnpm compile", ms: 1500 },
  { name: "test", run: "pnpm test", ms: 2600 },
] as const;

export type RehearsalOptions = {
  readonly stream: NodeJS.WriteStream;
  readonly input?: NodeJS.ReadStream;
  /** Multiplies every pause. `1` is paced like a run; `0` waits for nothing, for a test. */
  readonly speed: number;
  /** Where `log.txt` goes; a temp directory by default. */
  readonly dir?: string;
};

const TICKET = { identifier: "FAB-0", title: "A stage says which model runs it", type: "feat" as const };

/**
 * The run, assembled the way `run.ts` assembles the real one — the harness's
 * in-memory ports underneath, and on top of them, merged last so they win,
 * the four that a rehearsal wants to behave differently: a journal onto the
 * real screen, an agent with a script, a gate with a clock and one red
 * verdict, and a reviewer and a forge that wait the way theirs do.
 */
export const rehearse = (options: RehearsalOptions) =>
  Effect.gen(function* () {
    const pause = (ms: number) => Effect.sleep(ms * options.speed);
    const dir = options.dir ?? mkdtempSync(join(tmpdir(), "fabrika-rehearsal-"));

    const config: Partial<Config> = {
      gate: GATE.map(({ name, run }) => ({ name, run })),
      review: { provider: "cubic", requireScore: 5, maxRounds: 3, timeoutMinutes: 25 },
    };
    const world = harness({
      ticket: TICKET,
      config,
      reviews: [
        { commit: "sha1", score: 4, threads: [{ id: "t1", path: "src/config.ts", line: 12, body: "This comment still names the old default." }] },
        { commit: "sha2", score: 5, threads: [] },
      ],
    });

    // The same verdict `run.ts` makes: a terminal gets the screen, a pipe the
    // scrolling log — so `pnpm rehearse | cat` is what CI would see.
    const journal = fileJournal.layer(
      join(dir, "log.txt"),
      { stream: options.stream, archive: "log.txt" },
      [],
      isInteractive(options.stream) ? (opts) => openScreen({ ...opts, ticket: TICKET.identifier, input: options.input }) : undefined,
    );

    const agent = Layer.effect(Agent)(
      Effect.gen(function* () {
        const journal = yield* Journal;
        const calls = new Map<string, number>();
        return {
          ensureTools: () => Effect.void,
          ask: (request: AgentRequest) =>
            Effect.gen(function* () {
              const call = (calls.get(request.stage) ?? 0) + 1;
              calls.set(request.stage, call);
              const scene = sceneFor(request, call);
              yield* Effect.gen(function* () {
                yield* journal.log({ kind: "note", level: "detail", text: "[credential] default" });
                for (const beat of scene.beats) {
                  yield* pause(beat.ms);
                  if (beat.say) yield* journal.log({ kind: "agent", stage: request.stage, markdown: beat.say });
                  if (beat.tool) yield* journal.log({ kind: "tool", stage: request.stage, tool: beat.tool[0], subject: beat.tool[1] });
                }
              }).pipe(waitFor(journal, `${request.stage} agent`));
              yield* journal.log({ kind: "cost", stage: request.stage, usd: scene.usd });
              return { text: "", structured: scene.structured };
            }),
        };
      }),
    );

    const gate = Layer.effect(Gate)(
      Effect.gen(function* () {
        const journal = yield* Journal;
        let checks = 0;
        return {
          feedback: (failure) => `gate ${failure.name} failed:\n${failure.output}`,
          check: Effect.gen(function* () {
            checks += 1;
            // Red once, on the first check the run makes — implement's — so
            // the retry and the `FAILED` verdict are both on screen.
            const red = checks === 1 ? "test" : undefined;
            for (const [index, step] of GATE.entries()) {
              const event = { kind: "gate", name: step.name, at: index + 1, of: GATE.length, command: step.run } as const;
              yield* journal.log({ ...event, state: "start" });
              const started = Date.now();
              yield* pause(step.ms);
              // Timed rather than scripted, the way shell-gate times it, so
              // `--fast` says `0s` and never claims a wait it did not make.
              const seconds = Math.round((Date.now() - started) / 1000);
              if (step.name === red) {
                yield* journal.log({ ...event, state: "fail", seconds, exitCode: 1 });
                return { name: step.name, command: step.run, output: "✖ config: model is required\n  expected: undefined\n  actual: 'claude-sonnet-5'" };
              }
              yield* journal.log({ ...event, state: "pass", seconds });
            }
            return undefined;
          }),
        };
      }),
    );

    const reviewer = Layer.effect(Reviewer)(
      Effect.gen(function* () {
        const inner = yield* Reviewer;
        const journal = yield* Journal;
        return {
          ...inner,
          name: "cubic",
          owns: (name) => /cubic/i.test(name),
          await: (pr, commits, timeoutMinutes) =>
            pause(7000).pipe(
              Effect.andThen(inner.await(pr, commits, timeoutMinutes)),
              waitFor(journal, `cubic review of ${commits.map((sha) => sha.slice(0, 7)).join("/")}`, timeoutMinutes),
            ),
        };
      }),
    );

    const forge = Layer.effect(Forge)(
      Effect.gen(function* () {
        const inner = yield* Forge;
        const journal = yield* Journal;
        return {
          ...inner,
          settledChecks: (pr, sha, timeoutMinutes) =>
            pause(4000).pipe(
              Effect.andThen(inner.settledChecks(pr, sha, timeoutMinutes)),
              waitFor(journal, `checks on ${sha.slice(0, 7)}`, timeoutMinutes),
            ),
        };
      }),
    );

    // The harness has a journal of its own, a recording; the screen's goes to
    // the right of it so it is the one every step and every override gets.
    // The overrides are built on that base and merged to its right in turn,
    // so each of the four is the one the steps see, and the reviewer and the
    // forge inside them are still the harness's.
    const base = Layer.merge(world.layer, journal);
    const overrides = Layer.mergeAll(agent, gate, reviewer, forge).pipe(Layer.provide(base));
    const ports = Layer.merge(base, overrides);

    yield* fabrikaPipeline(world.config).run.pipe(Effect.provide(ports));
    return dir;
  });

const main = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (main) {
  const fast = process.argv.includes("--fast");
  rehearse({ stream: process.stdout, input: process.stdin, speed: fast ? 0.08 : 1 }).pipe(
    Effect.tap((dir) => Effect.sync(() => console.log(`rehearsal log: ${join(dir, "log.txt")}`))),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
