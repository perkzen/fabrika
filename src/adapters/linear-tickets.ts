import { Effect } from "effect";
import type { TicketSource } from "../ports/ticket-source.ts";
import { TicketNotFound, TicketSourceError, type Ticket, type TicketType } from "../ticket.ts";

type LinearResponse = {
  data?: {
    issue?: {
      identifier: string;
      title: string;
      description?: string | null;
      url: string;
      labels?: { nodes: Array<{ name: string }> };
    } | null;
  };
  errors?: Array<{ message: string }>;
};

/** start-linear-ticket's mapping: feature/story → feat, bug → fix, chore/task → chore. */
const typeFromLabels = (labels: ReadonlyArray<string>): TicketType => {
  const lower = labels.map((label) => label.toLowerCase());
  if (lower.some((label) => /bug|fix/.test(label))) return "fix";
  if (lower.some((label) => /chore|task|maintenance/.test(label))) return "chore";
  return "feat";
};

const QUERY = `query($id: String!) { issue(id: $id) { identifier title description url labels { nodes { name } } } }`;

/**
 * A Linear issue, over one GraphQL POST. Personal API keys go in
 * `Authorization` bare, per Linear's docs; this is the same read-only key the
 * `linear-ro` MCP server uses.
 *
 * The issue body is inlined into the ticket, which is why a Linear run needs
 * no MCP server: the server only adds comments and linked issues on top.
 */
export const source = (identifier: string, apiKey: string): TicketSource => ({
  fetch: Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: apiKey },
          body: JSON.stringify({ query: QUERY, variables: { id: identifier } }),
        }).then(async (r) => ({ status: r.status, json: (await r.json()) as LinearResponse })),
      catch: (cause) => new TicketSourceError({ message: `linear: ${String(cause)}` }),
    });
    if (response.status === 401 || response.status === 403) {
      return yield* new TicketSourceError({ message: `linear: HTTP ${response.status} — check LINEAR_API_KEY` });
    }
    const issue = response.json.data?.issue;
    if (!issue) {
      const why = response.json.errors?.map((e) => e.message).join("; ");
      return why && !/not found|entity/i.test(why)
        ? yield* new TicketSourceError({ message: `linear: ${why}` })
        : yield* new TicketNotFound({ identifier });
    }
    return {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      url: issue.url,
      type: typeFromLabels(issue.labels?.nodes.map((node) => node.name) ?? []),
    } satisfies Ticket;
  }),
});
