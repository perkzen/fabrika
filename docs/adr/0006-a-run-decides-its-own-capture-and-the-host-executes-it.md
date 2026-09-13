---
status: accepted
---

# A run decides its own capture; the host still executes it

`pr.capture` asked a repository to commit two things: the command that renders
a surface, and the globs saying which files change it. The globs are the weaker
half. They are a cached judgement with no invalidation — an import added to a
rendering module goes unnoticed, and the capture quietly stops firing on
branches that do change the surface. It fails silently and in the wrong
direction, and the judgement it caches ("did this branch change something a
person looks at?") is one the agent makes well against a diff it can read, and
one a glob makes badly against a path.

So `pr.beforeAfter: true` replaces both halves with one structured call at the
pull request. It answers whether this branch changed a surface and which single
command renders it, and the host runs that command in both checkouts exactly as
before. `pr.capture` survives as the pinned override.

The decision moves; the execution does not. The agent only ever holds the
branch tree, and the before half is rendered in a detached checkout of the base
that the agent has never seen. That checkout, its install, its cache and its
timeouts stay the host's.

## Considered Options

- **Let the agent take the screenshot itself, during a stage.** The obvious
  shape, and it cannot produce a before half at all: by the time any stage
  runs, the change exists. A comparison needs someone standing at the base.
- **Keep the command committed, drop only the globs.** Half the win, and the
  half that costs a contributor less. Rejected because the two are one
  judgement: a repository that can say which command renders a surface can say
  whether this branch touched it, and splitting them leaves the config carrying
  the part that goes stale.
- **Let the agent improvise the command in each checkout separately.** Rejected
  outright. Two improvisations produce a diff that shows the agent's mood
  rather than the change. The command must be fixed across the two halves — it
  need not be fixed across all time, which is the whole opening this ADR walks
  through.
- **A second agent call in the base checkout**, to render the before half from
  there. Rejected: it doubles the bill for evidence, and it is the same
  improvisation problem wearing a checkout.

## Consequences

- The command is now chosen by an agent and spawned by the host with no
  permission layer in front of it. `deny` gates the agent's own subprocess and
  reaches nothing here, so `FORBIDDEN` moved from `configure.ts` to `config.ts`
  and guards both callers. The name is decoded through `CaptureStep` rather
  than copied field by field, because the host makes a directory of that name
  and empties it recursively.
- The base half's cache key gained a hash of the command. Keyed by name alone,
  two tickets off one base with the same obvious name and different commands
  would pair one run's after against the other's before — the exact noise a
  fixed command exists to prevent, arriving silently.
- Every failure of the call ends as no section, rate limits included. The
  branch is already pushed by then, and a run that stops over its own evidence
  has broken the rule that a capture may never fail a run.
- A run costs one more short agent call, and answers "no surface" cheaply for a
  library or a server that has none.
- `beforeAfter: false` is off however `capture` is set. A config that still
  lists a command is not consent.
