---
status: accepted
---

# One session, one model

A `model` is configured per **stage** and at the top of `.fabrika/config.json`,
never per **stage label**. A stage is one session by construction, so keying
the model to it cannot change model mid-conversation; a label cannot make that
promise, because a review round files three labels — the reviewer's, `ci` and
the gate repair — under one `round-<n>` session, and a base merge files `merge`
and `merge-gate` under one. Keying off the label would resume the same
conversation under a different `--model` twice, with nothing in the config
saying so. The agent calls that are not stages — the naming call, the review
round, the base merge — therefore take the top-level `model` and nothing
finer, and they take it from the agent adapter's own default rather than from
each call site, so a new call site inherits the rule instead of remembering
it.

## Consequences

Giving those three their own model is a config-shape change, not a field: it
needs a place for calls that are not stages, and a name for a thing the
operator has never had to name. That the cheapest call in the run — the
forty-token naming call — is also the one that cannot be tuned yet is the
known cost of taking the safe half now.
