import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { TicketSource } from "../ports/ticket-source.ts";
import { TicketSourceError, type Ticket, type TicketType } from "../domain/ticket.ts";

const asType = (raw: string | undefined): TicketType => (raw === "fix" || raw === "chore" ? raw : "feat");

/**
 * A local markdown spec: optional `key: value` frontmatter between `---`
 * lines, then markdown whose first `# H1` is the title.
 *
 * Deliberately not YAML — three scalar keys do not earn a parser — and
 * deliberately on `node:fs` rather than the filesystem service, so a ticket
 * source stays something a caller can run with nothing provided.
 */
export const source = (file: string): TicketSource => ({
  fetch: Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(file, "utf8"),
      catch: () => new TicketSourceError({ message: `cannot read spec file ${file}` }),
    });

    const front: Record<string, string> = {};
    let body = raw;
    const matter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    if (matter) {
      body = raw.slice(matter[0].length);
      for (const line of matter[1]!.split(/\r?\n/)) {
        const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*(?:#.*)?$/.exec(line);
        if (pair) front[pair[1]!] = pair[2]!.replace(/^["']|["']$/g, "");
      }
    }

    const heading = /^#\s+(.+?)\s*$/m.exec(body);
    const title = front.title ?? heading?.[1];
    if (!title) return yield* new TicketSourceError({ message: `${file}: no title: frontmatter or a "# heading"` });
    const description = (heading && !front.title ? body.replace(heading[0], "") : body).trim();

    const linear = front.linear?.trim();
    return {
      identifier: linear || front.id || basename(file).replace(/\.[^.]+$/, ""),
      title,
      description,
      ...(linear ? { url: `https://linear.app/issue/${linear}` } : {}),
      type: asType(front.type),
    } satisfies Ticket;
  }),
});
