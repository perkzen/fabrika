---
status: accepted
---

# Linear reaches a run through MCP, not a key the host holds

A ticket is a local markdown file and nothing else. `fabrika run PAR-123`, the
direct Linear GraphQL adapter and the `LINEAR_API_KEY` read out of
`~/.config/fabrika/.env` are gone; a stage that wants the issue declares
`mcp: ["linear-ro"]`, and the agent reads it — comments and linked issues
included — at the point it needs it.

The host's own fetch was always the weaker half of the pair. It got one
GraphQL query's worth of an issue: identifier, title, description, url,
labels. The server the default `spec` stage already named got the comments and
the linked issues on top, which is where the argument about a ticket actually
lives. So the host fetch supplied the run nothing the server could not, at the
price of being the one component holding a credential — a `.env` loaded into
the process, inherited by every child, and stripped back out by name in
`shell-captures.ts` before a capture could print it onto a pull request.

What survives from it is the `linear:` frontmatter key `file-tickets.ts`
already read: the identifier on the branch and the URL in the pull request
body. Both are facts *about* a ticket rather than reads *of* one, so neither
needs a key.

## Considered Options

- **Resolve the identifier through a `claude -p` call with `linear-ro`,**
  keeping `fabrika run FAB-7` working; `mcp.ts` already resolves servers and
  `ensureTools` already checks them. Rejected: it puts an agent call and a
  structured-output parse in front of the branch step, makes "what am I
  building?" depend on Claude auth and on a model answering in schema, and
  buys back only the invocation shape — the ticket file the answer would be
  written into is the thing to write either way.
- **Keep the key and the adapter, and treat MCP as an extra.** The status quo.
  Rejected: two ways to reach one system, one of them a secret the host has to
  hold and then scrub, for a fetch that is a strict subset of the other.
- **Drop the `TicketSource` port along with its second implementation.**
  Rejected: one implementation is still the seam that stops the pipeline
  reaching for a file itself, and it is the shape anything else that answers
  the question would have to take.

## Consequences

fabrika stores no credentials at all. `claude`, `gh` and each MCP server hold
their own, so there is nothing for a worktree or a capture to leak.
`withoutSecrets` stays — a capture still inherits the operator's shell — but it
is now defence against the environment rather than cleanup of something
fabrika loaded into it.

A stage naming `linear-ro` fails preflight when the server is not registered,
which is the intended order: register once with `claude mcp add -s user`, then
name it. A repo that never registers it runs from the ticket file alone, and is
told nothing is missing, because nothing is.

`TicketNotFound` went with the adapter that threw it. A spec file that is not
there is a `TicketSourceError`, the same as one that cannot be parsed.
