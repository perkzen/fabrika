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

### The review loop

**Reviewer**:
The port one run waits on after its draft PR opens, chosen per repo by
`review.provider`: what the branch scored, and which of the bot's findings are
still open. A repo with no review bot has one too — the adapter that reviews
nothing.
_Avoid_: review bot — that is the service behind the adapter; code reviewer;
the `review` code stage, which is the agent reviewing its own diff before the
PR exists.

**Review bot**:
The external service a reviewer adapter speaks to, cubic today. Having none is
a configuration (`review.provider: "none"`), not a missing reviewer.
_Avoid_: reviewer, linter, CI.

**Review round**:
One pass of the loop after the draft PR: wait for the reviewer and for the
pushed commit's checks, hand back whatever is actionable, gate, push. A run
gets at most `review.maxRounds` of them.
_Avoid_: iteration, retry, attempt.

**Check**:
One signal the forge reports on the pushed commit — a CI job or a commit
status. The reviewer's own check is not one: `owns` takes it out before the
loop can wait on the signal the loop is producing.
_Avoid_: status, CI run, test.

### Showing the change

**Capture**:
A named command in the committed config that renders one user-visible surface
to files, run by the host in a checkout. fabrika never looks inside what it
writes, so the same contract serves a simulator screen, a browser page, a
window and a terminal frame.
_Avoid_: screenshot — an image is one of the three kinds a capture may write;
snapshot, visual test.

**Shot**:
One capture's two halves: the files it wrote at the base, and the files it
wrote on the branch. Either half may be absent, which is how a capture that is
new on the branch and one that produced nothing are both said.
_Avoid_: pair, comparison, result.

**Before / After**:
The pull-request body section that carries each capture twice — the same
surface rendered at the base and on the branch, side by side — for the half of
a change a diff cannot show.
_Avoid_: visual diff, preview, comparison.
