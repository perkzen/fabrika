import { Data } from "effect";

/**
 * A plain `Error` in an Effect error union swallows every tagged error
 * (they all extend Error), so `catchTag` stops seeing them. Use this instead.
 */
export class FabrikaError extends Data.TaggedError("FabrikaError")<{ readonly message: string }> {}

const detail = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) return String((cause as { message: unknown }).message);
  return String(cause);
};

/**
 * Maps an adapter's own failure — a shell exit, a platform error — onto the
 * one error every port speaks. The ports describe what fabrika does; a caller
 * deciding what to do next has never needed to know whether the cause was a
 * spawn or a missing file, only what was being attempted when it failed.
 */
export const asFabrikaError = (attempted: string) => (cause: unknown) =>
  new FabrikaError({ message: `${attempted}: ${detail(cause)}` });
