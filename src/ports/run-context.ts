import { Context } from "effect";
import type { Config } from "../config.ts";
import type { Ticket } from "../domain/ticket.ts";

/** The two things fixed for the whole run: what is being built, and under which rules. */
export interface RunContext {
  readonly ticket: Ticket;
  readonly config: Config;
}

export const RunContext = Context.Service<RunContext>("RunContext");
