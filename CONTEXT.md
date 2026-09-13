# fabrika

An Effect-based runner that drives Claude Code through spec, plan, implement,
refactor, security and review stages on a ticket, then waits on an automated
reviewer until the branch is ready for a human.

This glossary grows as terms are resolved; it is not yet a complete inventory
of the domain.

## Language

### Reporting a run

**Journal**:
Where a run says what it is doing. It carries run events, not pre-formatted
strings, and fans each one out to every surface that reports the run.
_Avoid_: logger, output stream.

**Run event**:
One thing worth telling the operator about — a step beginning, a gate step's
verdict, something the agent said, a wait opening or closing, the terminal
result. It is data with a kind, never a formatted line.
_Avoid_: log line, log message, log entry.

**Presenter**:
The stateful object that owns one output surface and turns run events into
what that surface shows. One per surface; the console's is the only one that
animates.
_Avoid_: renderer, reporter, writer — *render* stays the verb (render
markdown, render a line), so the noun has to be something else.

**Archive**:
The run's own uncapped copy of itself, `log.txt` — every event, plain and
stamped, kept whether or not anyone is watching the console. It is the
surface an elided console line points at.
_Avoid_: log file, transcript — *transcript* is the agent's raw stream-json,
which is a different file.

**Plain rendering**:
A run event as ANSI-free text lines, unstamped — the timestamp belongs to the
surface that writes them. It is what `log.txt` always receives, and what a
non-interactive console emits for every kind but agent speech, which the
console always walks and caps.
_Avoid_: log format, raw output.

**Agent speech**:
What the agent said, as the markdown it said it in. The archive keeps it
whole and raw; a console walks it into styled lines and caps its height,
because one message must not own the screen.
_Avoid_: agent output, message text, assistant text.

**Interactive**:
The verdict that the console may use colour, animation and cursor movement.
False for a non-TTY stdout, `NO_COLOR`, `TERM=dumb` and CI alike — a run is
either fully dressed or fully plain, never partly.
_Avoid_: TTY, isTTY — those are one input to the verdict, not the verdict.

**Live region**:
The lines at the bottom of an interactive console that a presenter redraws in
place: run progress, and whichever of gate progress or an open wait applies.
Everything above it is permanent scrollback and is never rewritten.
_Avoid_: status bar, footer, HUD.

**Wait**:
A stretch in which the host is blocked on something it does not control — an
agent call, the reviewer, the PR's checks. A wait has a subject and sometimes
a deadline, and is what the live region animates to prove the run is alive.
_Avoid_: poll, spinner, hang.
