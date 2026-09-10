import { Data } from "effect";

/**
 * A plain `Error` in an Effect error union swallows every tagged error
 * (they all extend Error), so `catchTag` stops seeing them. Use this instead.
 */
export class FabrikaError extends Data.TaggedError("FabrikaError")<{ readonly message: string }> {}
