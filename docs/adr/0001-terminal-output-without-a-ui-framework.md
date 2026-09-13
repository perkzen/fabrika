---
status: accepted
---

# Terminal output is hand-rolled over `util.styleText`, not built on Ink

fabrika's console output is a scrolling log with a two-line live region under
it, so the presenter owns `stdout` directly: colour comes from Node 24's
built-in `util.styleText`, the live region from `ESC[nA` / `ESC[0J` with every
live line truncated to `columns - 1` so it can never wrap, and markdown from
`marked`'s lexer walked into styled lines by our own code. Ink is the
reference implementation of this output shape and was the leading candidate,
but it replaces only the live-region redraw — the run event union, the colour,
the markdown walker, `tool_use` extraction and the whole plain path are
identical code either way — and at a live region of at most two non-wrapping
lines, the reconciliation and wrapped-height measurement it exists to provide
buy nothing.

## Considered Options

- **Ink 7 + React 19** — correct by construction and the right model
  (`<Static>` above a redrawing region), but ~38 packages and a React runtime
  on a repo with three dependencies, a second rendering paradigm inside an
  Effect codebase, and a `Journal.write` that must stay synchronous would have
  to reach React through an external store and Ink's render throttling.
  Rejected on cost against what it actually replaces, not on capability.
- **`marked-terminal`** — rejected: its peer range caps at `marked <16`, and
  it pulls `cli-highlight` → `highlight.js`, `yargs`, `parse5`. It also owns
  the rendered shape, which is the part that must obey our height cap and
  gutter.
- **`cli-spinners`, `cli-progress`** — rejected: a frame set is one array
  literal, and a progress bar is one `"█".repeat(n)`. `cli-progress` also
  moves the cursor itself, which would fight the live region.
- **`marked`** — accepted, lexer only. Markdown parsing is the one genuinely
  non-trivial job here and it has zero transitive dependencies, ships its own
  types, is ESM, and declares `node >= 20`.

## Consequences

No JSX, so `node src/cli.ts` keeps working with no build step and the README
and `docs/internals.md` stay accurate. The cost is that the live region's
correctness rests on the truncate-to-`columns - 1` rule; a future live region
that needs to wrap, or needs more than a couple of lines, is the signal to
reopen this. If Ink is ever reconsidered, the unverified question is whether
`patch-console` redirects a `Console.error` issued while Ink is mounted, which
the `ESCALATED:` path depends on.
