---
status: accepted
---

# A sweep hands out pull requests, not tickets

`fabrika sync` discovers work through one `gh pr list` and treats each pull
request as the unit: a sync needs the branch, the title, the base and the
merge state, all of which the PR carries, and `syncWithBase` reads nothing
from a ticket — `prompts/merge.md` interpolates `base`, `files`, `identifier`
and `title`, and the identifier and title are the PR's own title, which
`pull-request.ts` writes as `${identifier}: ${title}`. So a sweep needs no
Linear call, no ticket record and no run directory, and it syncs a hand-written
PR as readily as one fabrika opened.

## Considered Options

- **`fabrika sync <ticket>`, resuming the ticket's run.** The obvious shape,
  and the one the rest of the CLI is built around. Rejected because the sweep
  hands out PRs: mapping one back to a ticket means either parsing
  `{ticket}` out of a branch pattern that is config-dependent, or scanning
  `~/.fabrika/runs/<repo>/*/state.json` for a matching `prNumber` — which is
  machine-local and finds nothing for a PR opened from another machine. It
  also inherits `runTicket`'s `state.done` short-circuit, whose only escape is
  deleting the run directory that holds the sessions and the archive.
- **Requiring the run directory, and skipping a PR without one.** Rejected:
  the lookup buys session reuse and nothing else, so it is best-effort. A PR
  with no run directory gets a fresh one keyed by its own identity.

## Consequences

Both paths need a key where there is no ticket, so the worktree and run
directory are keyed by `<identifier>-<number>` (`pr-<number>` when the title
does not parse). The number is in the key deliberately: two open PRs can carry
the same identifier in their titles, and two workers in one worktree is two
agents in one tree.

The run state is read, never rewritten by a sync beyond the session ids the
agent adapter records: `done` stays true, because the run reached its verdict
and a sync is not a resumed run.
