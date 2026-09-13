---
status: accepted
---

# A repo with no review bot is an adapter, not a hole in the `Reviewer` port

`ghForge` consumes `Reviewer` to keep the bot's own status check out of the
checks the loop waits on, so a run with no review bot still has to answer the
port — `Option<Reviewer>` would ripple through `run.ts` and the forge for
nothing. The adapter that answers it returns a `Review` with no score and no
threads immediately, and the port carries one new property, `scores`, saying
whether its verdict is part of "done"; the review loop reads that property and
never reads `review.provider`, so choosing a provider stays a single line in
`run.ts`.

## Considered Options

- **Split the port** into a waiting half and a thread-answering half, so the
  adapter that never produces a thread has no `reply`, `resolve`,
  `renderThreads`, `decisionSchema` or `prompts` to stub. Honest, and it makes
  the stubs unrepresentable rather than unreachable — rejected because it
  restructures the cubic adapter's shape for an adapter whose stubs are already
  unreachable behind `if (threads.length > 0)`, and the ticket asked for the
  option that leaves cubic alone.
- **Compare `config.review.provider` inside the loop** rather than adding a
  property. Rejected: the loop is the one place written against the port rather
  than against a provider, and a third provider would then mean editing the
  loop instead of one line in `run.ts`.
- **Return `undefined` from `await`**, reusing the "no review arrived" answer.
  Rejected outright: `undefined` means *timed out* and escalates, which is the
  bug this ticket exists to fix.
