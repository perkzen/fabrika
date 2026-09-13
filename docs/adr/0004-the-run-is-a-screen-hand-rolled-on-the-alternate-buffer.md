---
status: proposed
supersedes: ADR-0001
---

# An interactive run is a screen on the alternate buffer, still hand-rolled

An interactive `fabrika run` leaves the scrolling log behind: it enters the
terminal's alternate buffer and draws the outline of the run — one line per
step, the running one unfolded under its line — redrawing the whole viewport
rather than two rows at the bottom of scrollback. ADR-0001 named the signal to
reopen it ("a future live region that needs to wrap, or needs more than a
couple of lines"), and folding a finished step is that signal: a step's lines
are permanent scrollback today, and once they have scrolled past the top of
the viewport no cursor sequence can reach them. The framework answer does not
change with the shape, though — the screen stays hand-rolled over
`util.styleText` and a handful of escape sequences, because the ticket's own
testability requirement (the tree, its rendering to lines, and its key
handling are three pure functions with no terminal in them) leaves a framework
nothing to do but blit strings we have already laid out.

## Considered Options

- **Ink 7.1.1 + React 19.2** — measured on 2026-09-13 rather than assumed: 38
  packages, engines `node >=22` against this repo's `>=24`, peers
  `react >=19.2.0`, `@types/react` and `react-devtools-core`, and its own
  dependencies include `ws`, `yoga-layout`, `react-reconciler` and
  `scheduler`. Rejected, for the third time and now on the current shape: its
  two real contributions are wrapped-height measurement and frame diffing, and
  this design needs neither — the renderer emits exactly `rows` lines of at
  most `columns - 1` columns each, so a frame is a cursor-home and a write.
  Two further facts weighed against it. `exitOnCtrlC` defaults to `true` and
  exits the process on `\x03`, which is exactly the preemption of the MCP
  finalisers that `console.ts` already refuses to do on SIGINT. And JSX costs
  the from-source loop: `node src/cli.ts` and `node --test test/*.test.ts` both
  run on Node's type stripping, which cannot strip JSX, so every entry point
  and both docs would move to `tsx` — or the component tree would be written in
  `React.createElement`, at which point the React is decoration.
- **The `patch-console` question ADR-0001 left open** — measured and closed
  regardless of the outcome above. With `patchConsole` on, Ink replaces
  `console.error` while mounted and routes what it is given to **stderr**, not
  stdout, and restores the original function on unmount. It could not have
  broken the `ESCALATED:` path in any case: the journal layer's finalizer ends
  every presenter before the error reaches `cli.ts`, and Effect's layer
  finalizers were verified to run ahead of the caller's `catchTag`.
- **OpenTUI 0.5.11** — still out, and on harder ground than FAB-1 found it:
  `node >=26.4.0` and `bun >=1.3.0` against this repo's `>=24`, plus eight
  native platform packages. The shape has moved toward what it is built for
  and the engine range has not moved at all.
- **Keeping the scrollback shape and writing only summaries** — the honest
  fallback: one permanent summary line per finished step, the running step's
  tail in the live region, no keys. Rejected because it cannot unfold a
  finished step, which is half of what the operator asked for, and because the
  work it saves (an alt-buffer enter/leave, raw-mode key decoding, a viewport
  budget) is smaller than it looks once the three pure functions exist — they
  are needed for the summaries either way.

## Consequences

The alternate buffer has no scrollback, so for the length of a run the
terminal's own scrollbar is gone; `log.txt` and the folded outline written on
the way out are what replace it, and leaving a blank screen behind on any exit
path would be worse than the wall this replaces. Raw mode is what the keys
cost: it holds the event loop open and it stops the terminal from raising
SIGINT, so `\x03` has to be turned back into one by hand and raw mode has to
be released on the run ending, on `ESCALATED:`, on a usage limit and on
SIGINT. ADR-0001's truncate-to-`columns - 1` rule survives and is now the
outline's rule; the wrapping it warned about is owned deliberately and only
inside an unfolded step's window, where agent prose is the point and a cut
line would defeat it. The non-interactive path — a pipe, `NO_COLOR`,
`TERM=dumb`, CI, `log.txt`, and `init` — keeps the presenter ADR-0001
described, unchanged, which is why that ADR is superseded rather than deleted.
