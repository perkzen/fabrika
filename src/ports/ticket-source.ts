import type { Effect } from "effect";
import type { Ticket, TicketSourceError } from "../domain/ticket.ts";

/**
 * Where the work to do comes from. An adapter is bound to one reference — a
 * path to a spec file — so the interface is the single question the CLI asks:
 * what am I building?
 *
 * One implementation today, and still a port: it is the seam that keeps the
 * pipeline from reaching for a file, and the shape anything else that answers
 * the question has to take.
 *
 * Not a `Context.Service`: the source is resolved to a `Ticket` before the
 * pipeline starts, so nothing downstream can tell what answered.
 */
export interface TicketSource {
  readonly fetch: Effect.Effect<Ticket, TicketSourceError, never>;
}
