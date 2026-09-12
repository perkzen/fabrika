import { Context, type Effect } from "effect";
import type { FabrikaError } from "../errors.ts";

export type GateFailure = { readonly name: string; readonly command: string; readonly output: string };

/**
 * The checks every code stage has to pass, run by the host rather than the
 * agent so "green" is not something the agent can assert.
 *
 * `check` is the whole thing: which steps apply to what changed, in what
 * order, and the output tail of the first one that fails. `undefined` is
 * green. `feedback` turns a failure into the message the agent is handed,
 * which belongs here because the two have to agree on how much output an
 * agent can act on.
 */
export interface Gate {
  readonly check: Effect.Effect<GateFailure | undefined, FabrikaError>;
  readonly feedback: (failure: GateFailure) => string;
}

export const Gate = Context.Service<Gate>("Gate");
