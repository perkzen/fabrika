// Deliberate beside the Effect spawner below: `detached` is a fire-and-forget
// fork whose child outlives this process, which is not a shape an Effect that
// awaits an exit code can have.
import { spawn } from "node:child_process";
import { Data, Effect, Stream } from "effect";
import type { PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export type ShellResult = { readonly code: number; readonly out: string };

/**
 * Variables whose *names* say they hold a credential. `fabrika run` loads
 * `~/.config/fabrika/.env` into its own environment for its own Linear and
 * Claude calls, so this process holds keys the operator's own shell does not
 * — and every child inherits all of it unless told otherwise.
 */
const SECRET = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_AUTH|^AUTH/;

/** An environment minus anything named like a credential. */
export const withoutSecrets = (environment: NodeJS.ProcessEnv): Record<string, string> => {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && !SECRET.test(name.toUpperCase())) kept[name] = value;
  }
  return kept;
};

/**
 * Fire and forget, and never fatal: the child outlives the `process.exit`
 * `cli.ts` is about to call, and a failure to start it is swallowed — a
 * notification nobody sees, or an editor that never opened, is not a failed
 * run. No shell, ever.
 *
 * The environment is stated rather than inherited, because neither child has
 * any work that needs this process's keys and one of them is an editor the
 * operator then lives inside.
 */
export const detached = (bin: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv): void => {
  const child = spawn(bin, [...args], { stdio: "ignore", env });
  child.on("error", () => {});
  child.unref();
};

export class ShellFailed extends Data.TaggedError("ShellFailed")<{
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly code: number;
  readonly out: string;
}> {}

/**
 * Runs argv (no shell) in cwd; stdout and stderr are interleaved into `out`
 * in arrival order, which is what a human reads in a gate failure — that is
 * exactly what the handle's `all` stream carries.
 * `GH_PROMPT_DISABLED` keeps `gh` from hanging on a question nobody answers.
 *
 * `extendEnv` false gives the child `env` and nothing else, for the caller
 * that needs a variable *absent* rather than overridden — merging cannot
 * unset.
 */
export const exec = (
  cwd: string,
  argv: ReadonlyArray<string>,
  env: Record<string, string> = {},
  extendEnv = true,
): Effect.Effect<ShellResult, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const [bin, ...args] = argv;
      // `extendEnv` defaults to false in v4: without it the child loses PATH.
      const proc = yield* spawner.spawn(
        ChildProcess.make(bin!, args, {
          cwd,
          env: { GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", ...env },
          extendEnv,
          // Stated rather than inherited: a key the operator presses at the
          // screen must never reach a gate command, and a release candidate's
          // default can move.
          stdin: "ignore",
        }),
      );
      const out = yield* proc.all.pipe(Stream.decodeText(), Stream.mkString);
      const code = Number(yield* proc.exitCode);
      return { code, out };
    }),
  );

/** `exec` that fails on a non-zero exit; returns trimmed output. */
export const run = (cwd: string, argv: ReadonlyArray<string>, env?: Record<string, string>) =>
  exec(cwd, argv, env).pipe(
    Effect.flatMap((r) =>
      r.code === 0 ? Effect.succeed(r.out.trim()) : Effect.fail(new ShellFailed({ argv, cwd, code: r.code, out: r.out })),
    ),
  );

/** Same, through `sh -c`: for gate commands the user wrote as one string. */
export const sh = (cwd: string, script: string, env?: Record<string, string>, extendEnv?: boolean) =>
  exec(cwd, ["sh", "-c", script], env, extendEnv);
