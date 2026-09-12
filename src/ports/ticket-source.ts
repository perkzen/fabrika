import type { Effect } from "effect";
import type { Ticket } from "../ticket.ts";
import type { TicketNotFound, TicketSourceError } from "../ticket.ts";

/**
 * Where the work to do comes from. Each adapter is bound to one reference —
 * a Linear identifier, a path to a spec file — so the interface is the single
 * question the CLI asks: what am I building?
 *
 * Not a `Context.Service`: the source is chosen by the command line and
 * resolved to a `Ticket` before the pipeline starts, so nothing downstream
 * can tell which one answered.
 */
export interface TicketSource {
  readonly fetch: Effect.Effect<Ticket, TicketSourceError | TicketNotFound, never>;
}
