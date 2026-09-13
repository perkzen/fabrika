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

### Syncing conflicted pull requests

**Trailer**:
The line fabrika ends every pull-request body it writes with, and the only
thing that says a pull request is its own rather than one the operator wrote
by hand. A sweep reads it to say whose each reported line is.
_Avoid_: footer, signature, marker, stamp — *stamp* is the timestamp a surface
puts on a line.

**Sweep**:
One invocation that lists the operator's open pull requests, picks the
conflicted ones and syncs each. It ends when they are all handled — a sweep is
a pass over the repository, never a process that stays alive watching it.
_Avoid_: watcher, daemon, monitor, poller — what invokes a sweep on a schedule
is the operator's, not fabrika's.

**Sync worker**:
One pull request's share of a sweep: its own worktree, run directory, gate and
agent session, run alongside a bounded number of others. It is a layer graph,
not a Claude sub-agent, and it shares nothing with its siblings.
_Avoid_: job, task, sub-agent, thread.

**Merge state**:
What the forge says about a pull request against its base: conflicted, behind,
clean, or unknown because GitHub has not finished computing it. Only
*conflicted* is a sweep's business.
_Avoid_: mergeable, mergeStateStatus — those are the two GitHub fields the
state is read off; conflict status.

**Sync outcome**:
What one worker produced, as a value: synced, already clean, escalated,
failed, or skipped with the rule that skipped it. A worker never fails its
sweep — the outcomes are collected and the worst one is the exit code.
_Avoid_: result, status, error.
