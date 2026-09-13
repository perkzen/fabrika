---
id: FAB-1
type: feat
---

# Make a fabrika run legible while it is running

## Problem

A fabrika run takes tens of minutes and prints a flat wall of timestamped
lines. Nothing in that wall says how far along the run is, whether the thing
that has printed nothing for four minutes is working or wedged, or which of
the words on screen are the agent talking and which are the host reporting.

Three specific failures:

1. **No sense of progress.** A run is a known list of steps — preflight,
   branch, workspace, each configured stage, the PR, then review rounds — and
   the operator is never shown that list or their position in it. `gate` has
   the same problem one level down: it is a known list of commands from
   `.fabrika/config.json` and prints one line per command with no sense of
   how many are left.

2. **No sense of liveness.** The longest waits in a run have the least
   output. A stage's agent call can run for minutes between assistant
   messages; `waiting for cubic review` prints once and then nothing for up
   to `review.timeoutMinutes` (25). There is no way to tell a working run
   from a hung one without `ps`.

3. **Everything looks the same.** Every line is `HH:MM:SS ` plus text, in the
   terminal's default colour. A `gate compile: FAILED` line, an agent's
   paragraph of reasoning, and `PR https://...` are typographically
   identical. Agent text is markdown — headings, lists, `inline code`,
   fenced blocks — and it is currently flattened with
   `.replace(/\n/g, " ")` and cut at 400 characters, so a numbered plan
   arrives as one long run-on line with stray `##` and `*` in it.

## Solution

A run should read like a tool that knows what it is doing: a live progress
line for the run and for the gate, a spinner with elapsed time wherever the
host is waiting on something slow, colour and weight that separate host
reporting from agent speech from failure, and agent markdown rendered as
markdown.

## Both output surfaces are in scope

There are two, and they do not share code today:

- **`fabrika run`** — goes through the `Journal` port
  (`src/ports/journal.ts`, `src/adapters/file-journal.ts`), which fans one
  string out to `console.log` and to `log.txt`.
- **`fabrika init`** — does not use `Journal` at all. `src/cli.ts` prints
  with `Console.log` and, for the configure call's streaming output, a raw
  `console.log` with its own `.slice(0, 160).replace(/\s+/g, " ")`. This is
  the surface in the screenshot that prompted the ticket: the `init` notes
  arrive as an unbroken grey paragraph.

Fixing only the first one leaves the most-looked-at surface unchanged. Both
get the same treatment and, where it makes sense, the same code.

## Behaviour wanted

**Run progress.** The step list is known before the run starts. Show it and
show position — a bar or an `n/N` with the current step named. Steps already
done on a resume are shown as done, not re-counted as pending.

**Gate progress.** The gate's steps come from the committed config, so the
count is known. Show which step of how many, the command, and its duration
when it finishes. Green for a pass, red for a failure, and the failing
command still legible.

**Liveness.** Anywhere the host is waiting on something unbounded — an agent
call, a cubic review, a CI check — show an animated indicator with elapsed
time, and for the waits that have a deadline (`review.timeoutMinutes`,
`checks.timeoutMinutes`) show the remaining budget too. "Thinking" shimmer,
a spinner, a dot-matrix cycle: pick what reads well, but it must be
*obviously* animating, because its whole job is to prove the run is alive.

**Colour and hierarchy.** Distinguish at least: host step boundaries, gate
pass, gate failure, agent speech, cost lines, warnings, and the terminal
result (PR URL or escalation). Dim the timestamp — it is the least
interesting thing on every line and currently the first thing. Indentation
or a gutter should make "this belongs to the stage above" readable without
reading the words.

**Markdown.** Agent text is rendered as markdown, not flattened. At minimum:
headings, bold, bullet and numbered lists, inline code, and fenced code
blocks (syntax highlighting is welcome, not required). The
`.replace(/\n/g, " ")` goes away — you cannot render a list after destroying
its newlines.

Flattening was doing one useful job, which is keeping one agent message from
flooding the screen. Replace it with a rule that survives markdown: cap the
rendered height of a single message and say how much was elided (the full
text is in `log.txt` and in the raw `stream-json` file either way). Pick the
cap; state it in the spec.

**Tool activity — in scope.** `src/infra/claude.ts:interpret` reads only
`text` blocks off the assistant events and drops everything else. The same
events carry `tool_use` blocks, which is where most of a stage's minutes
actually go. Surface them compactly — the tool and its subject, one short
line each, e.g. the command for a Bash call and the path for a file edit —
so the quiet minutes have something in them. Do not dump tool inputs
verbatim; they can be enormous.

## Constraints

These are the things that will break if the spec does not plan for them.

- **`Journal.write` stays a plain synchronous function.** It is called from
  the `stream-json` callback in `src/adapters/claude-agent.ts`, which is not
  an Effect. The port may grow — structured events instead of pre-formatted
  strings is the likely shape, and probably the right one — but this
  property is load-bearing.
- **`log.txt` stays plain text**: no ANSI, no spinner frames, no cursor
  escapes, timestamps kept. It is a post-mortem artifact that gets grepped
  and pasted into issues. Today the identical `stamped` string goes to the
  console and to the file; that has to become two renderings of one event.
- **The piped contract holds.** The last stdout line of a clean run is still
  the PR URL. `ESCALATED:` and the usage-limit message stay on stderr with
  exit codes 2 and 3. Someone pipes this.
- **Degrade to today's output when the terminal is not interactive.** Not a
  TTY, `NO_COLOR` set, `TERM=dumb`, or CI: no colour, no animation, no
  cursor movement — plain lines, one per event, which is exactly what
  `log.txt` gets. This is the default case under `2>&1 | tee`, so it has to
  be the tested case, not the afterthought.
- **`test/harness.ts` keeps working.** The in-memory `Journal` is used by
  every test; the tests in `test/` must still pass. If the port changes
  shape, the harness changes with it.
- **`init` has no run directory.** Whatever `run` uses for rendering must be
  usable from `cli.ts` before any `Journal` exists.

## Dependencies

The repo has three runtime dependencies, all Effect. Its taste is that a
small job does not earn a package. That is a bias, not a ban: a focused,
well-maintained package that does one of these jobs properly is preferable
to hand-rolling it.

- Node 24 ships `util.styleText`, which already honours `NO_COLOR` and
  `isTTY` when handed a stream. That is the zero-dependency baseline for
  colour and probably where colour should come from.
- Spinner frames, progress bars and a markdown-to-ANSI renderer are the
  three places a dependency might genuinely pay for itself. Evaluate the
  small focused ones (`cli-spinners`-class frame sets, a `cli-progress`-class
  bar, a `marked`-based terminal renderer) and justify each one you take or
  leave.
- **Ink is an acceptable answer, and is the strongest candidate.** It is the
  reference implementation of exactly this output shape: `<Static>` writes
  permanent scrollback lines while a live region below them redraws, which
  is "a scrolling log with a progress line and a spinner under it" stated as
  a component tree. Claude Code — the binary fabrika drives — is an Ink app.
  Nothing else in this process writes to the terminal (every subprocess in
  `src/infra/shell.ts` and `src/infra/claude.ts` is piped and consumed as a
  stream), so a renderer owning `stdout` costs nothing here.

  Its price, named honestly: ~26 transitive dependencies and a React 19 peer
  on a repo that has three. That is the trade to argue for or against in the
  spec — not a blocker, and not a foregone conclusion either. A hand-rolled
  renderer over `styleText` plus a frame set is still a legitimate answer if
  the spec can defend it.

  Two constraints if Ink is taken, both verified on this machine against
  `ink@7.1.1` and Node 24.15:

  - **JSX is allowed, and costs the bare-`node` dev loop.** Node refuses
    `.tsx` outright (`ERR_UNKNOWN_FILE_EXTENSION`) — it strips types, it does
    not transform JSX. Both ways out were measured on this repo's tsconfig:

    - `React.createElement` or `htm` from a `.ts` file keeps `node
      src/cli.ts` working exactly as documented, and costs nothing else.
      More verbose at the call site.
    - `.tsx` works too, and the blast radius is smaller than it looks:
      `tsx` is already a devDependency here and runs it as-is; adding
      `"jsx": "react-jsx"` to `tsconfig.json` does **not** conflict with
      `erasableSyntaxOnly` (`tsc --noEmit` stays green); `tsc -p
      tsconfig.build.json` emits `.js` from `.tsx` with
      `rewriteRelativeImportExtensions` intact, and the built `dist/` runs
      under plain `node`. The published package is unaffected.

    The cost of `.tsx` is therefore exactly one thing: the from-source dev
    command becomes `npx tsx src/cli.ts`, and the README's "there is no build
    step in the loop" plus the matching note in `docs/internals.md` have to
    be corrected. **Either choice is acceptable. Whichever the spec takes, it
    updates those docs and the `compile` gate config to match** — a stale
    README here is the kind of thing that costs the next person an hour.
  - **The piped contract already holds, and must keep holding.** Piped to a
    file, Ink emits zero escape codes — `<Static>` lines and the final live
    frame arrive as plain text, and a `console.log` after `unmount()` is
    still the last line on stdout. Same under `NO_COLOR=1` and `CI=true`.
    Under a TTY it emits cursor-hide and synchronized-update sequences and
    restores the cursor on unmount. Both paths are acceptance criteria, so
    test both.

- **OpenTUI (`@opentui/*`) is out**, on fit and risk rather than on a hard
  block. It does install and import on Node 24 — measured, `@opentui/core`
  0.5.11 imports fine on 24.15 — so the case against it is not "it breaks":

  - It **declares** `engines: { bun: ">=1.3.0", node: ">=26.4.0" }`. fabrika
    declares `>=24`, which is LTS until 2028; Node 26 is not LTS until
    2026-10-28. Working today outside a dependency's declared support window
    is not the same as being supported by it.
  - It is **Bun-first**: `bun-ffi-structs` is a core dependency and its own
    development requires Bun. Node is the secondary target.
  - Its core is **Zig compiled to eight prebuilt native platform packages**.
    Ink is pure JavaScript, and for a CLI people install globally, pure JS is
    the thing that never fails to install.
  - It is **pre-1.0** (0.5.11) against Ink's 7.1.1.
  - It is built for **programs you sit inside** — flexbox layout, scroll
    boxes, 3D, WebGPU, sound. OpenCode uses it for a chat UI. This ticket's
    Out of scope section rules out full-screen explicitly; fabrika prints a
    log and exits.

  None of that is disqualifying on its own. Together, against a library that
  does this job on the runtime fabrika already requires, it is enough.

- https://dotmatrix.zzzzshawn.cloud/ is an **aesthetic reference only**. It
  is a React/shadcn web component collection — not installable here, and
  `npx shadcn add` has nothing to do with this repo. Take the motion ideas
  (pulse, orbit, drift) and express them in braille/block frames.

## Out of scope

- A full-screen TUI: alternate screen buffer, panes, mouse, scrollback
  capture. The output stays a scrolling log that is nice to read. Adopting
  Ink does not change this — a live region under permanent `<Static>` lines
  is still a log, and taking over the screen is still out.
- Interactivity of any kind. A run is unattended; nothing may prompt.
- Changing what the pipeline does, which stages exist, or what any stage
  prompt says. This ticket changes how a run is *reported*, not how it runs.
- Reformatting `log.txt` beyond splitting it from the console rendering.

## Done when

- `fabrika run` on a TTY shows run progress, gate progress, an animated
  wait with elapsed time for every unbounded wait, colour-separated line
  kinds, rendered markdown, and compact tool activity.
- `fabrika init` gets the same colour and markdown treatment for its notes.
- The same run piped to a file produces plain, ANSI-free lines, and
  `log.txt` is plain, ANSI-free and timestamped.
- The PR URL is the last stdout line of a clean run; exit codes 2 and 3 still
  print to stderr.
- `pnpm test`, `pnpm compile` and `pnpm build` are green, with coverage for
  the TTY/non-TTY split and for the markdown height cap.
