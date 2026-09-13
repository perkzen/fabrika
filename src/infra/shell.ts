import { Data, Effect, Stream } from "effect";
import type { PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export type ShellResult = { readonly code: number; readonly out: string };

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
