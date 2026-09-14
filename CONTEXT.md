# fabrika

An Effect-based runner that drives Claude Code through spec, plan, implement,
refactor, security and review stages on a ticket, then waits on an automated
reviewer until the branch is ready for a human.

This glossary grows as terms are resolved; it is not yet a complete inventory
of the domain.

## Language

### Driving the agent

**Stage**:
One entry in the committed config's `stages` — a prompt, the role it runs
under, the model it runs on, the servers it may reach, and whether the gate
follows it. It is one conversation by construction.
_Avoid_: step — a step is the pipeline's unit of work, of which a configured
stage is one kind; phase.

**Choice**:
One thing a run can be asked to leave out, as the operator is offered it: a
configured stage or the pull request and its review loop together, each with
the name the run calls it, the title a reader calls it and the few words its
row shows. A fact about the config, so the question can be asked before a run
is assembled.
_Avoid_: option, row — a row is how a choice is drawn; step — a choice names
one, and a step that is never offered has none.

**Chosen steps**:
Which of a run's steps this invocation runs, decided before the run is
assembled — `--steps`, or the operator's answer to the select the command
opens with. A step nobody chose is left out of the pipeline rather than
skipped inside it, so the outline shows the run that was asked for.
_Avoid_: selection — the glossary already spends that word on what the
operator has highlighted on the screen; filter, subset; skip — a skipped step
is one the run contains and passes over, which an unchosen step never was.

**Session**:
The conversation an agent call belongs to, named by a key and resumed by the
session id recorded under that key. Several calls share one when they are one
conversation: a review round hands back threads, CI logs and a gate repair as
three calls and one session.
_Avoid_: conversation — that is what a session *is*, not what fabrika keys and
resumes; context, thread — a thread is one of the review bot's findings.

**Stage label**:
The name an agent call is filed under — it names the call's raw transcript and
rides on every event the call emits. Usually the stage's name, and
deliberately not the session's key when one conversation does several jobs.
_Avoid_: stage — a label may name something no config entry describes (`branch`,
`ci`, `merge`); transcript name.

### Where a run works

**Worktree**:
The git worktree a run does its work in, at
`~/.fabrika/worktrees/<repo>/<key>` — outside the repository fabrika was
invoked from, so nothing a run does touches the checkout the operator is
sitting in. Its path is the address the operator wants in hand: the screen's
header carries it, every exit prints it, and one key opens it in their editor.
_Avoid_: checkout, working copy, sandbox — *checkout* is the repository fabrika
was invoked from, which is a different directory a sweep also has.

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

**Surface**:
One place a run is reported to — a terminal a presenter draws on, or the file
the archive appends to — and, for the ones that are a terminal, everything
they are drawn with: the interactivity verdict, the styles a line is dressed
in, the size it is cut to, the cursor sequences and the loop that reads raw
stdin into keys. It sits under the presenters rather than inside any one of
them, so a screen, a console, a select and a banner share one of each.
_Avoid_: stream, output — a stream is one field of a surface, and a surface is
also what a run knows *about* the terminal it is on, which a stream is not.

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
The lines at the bottom of a scrollback console that a presenter redraws in
place: run progress, and whichever of gate progress or an open wait applies.
Everything above it is permanent scrollback and is never rewritten. It is the
scrollback shape's device; a screen redraws its whole viewport instead.
_Avoid_: status bar, footer, HUD.

**Select**:
The question `fabrika run` opens with: one row per step the run may leave
out, ticked, in the outline's own markers and columns, held in a rail that
opens at the title and closes under the list. It is drawn into scrollback
rather than onto the alternate buffer, and what it leaves behind is one
settled row naming the run that was chosen.
_Avoid_: prompt — that is what a stage sends the agent; picker, menu,
checklist.

**Rail**:
The line down the left of the select — the chip at `┌`, `◇` for a step
already settled, `◆` for the one being answered, `│` beside everything a
step has to say, and `◇` again on the row the answer leaves behind. It is
what says the question is one step of a flow rather than a wall of rows,
and it is the select's alone: a screen has the outline's margin instead.
_Avoid_: gutter, border, tree.

**Bulk row**:
The row above the list that takes or clears every step at once, named for
what it would do rather than what is true — `Select None (7/7)` when the
list is full. It is why there is no key for all and none: a row the operator
can see beats a letter they have to be told about.
_Avoid_: select all — that is one of its two labels, not its name; header.

**Screen**:
The presenter that owns the terminal's alternate buffer for the length of a
run and redraws the whole viewport — the outline, the unfolded step under its
line, and the keys that move and fold. An interactive run gets one and so does
an interactive sweep; `init`, a dry run, a pipe and every plain verdict get a
scrollback console instead.
_Avoid_: TUI, full-screen mode, alternate buffer — that is the terminal
facility a screen is drawn on, not the presenter.

**Row**:
One pull request's line on a sweep's screen, and the presenter bound to it
that the pull request's own worker writes through. It is what makes six
concurrent streams six windows rather than one: an event carries the row it
belongs to, and the address travels with the worker's layer graph. A run's
steps are drawn as rows too; only a sweep hands one out.
_Avoid_: lane, channel, track — and *step*, which is what a row draws.

**Rehearsal**:
The whole run on a stage set: the real select, pipeline, driver, journal and
screen over the test harness's in-memory ports, with a scripted agent and
timed waits, so everything the command does to a terminal — the question it
opens with included — can be looked at and a pipeline change watched end to
end without an agent bill. `pnpm rehearse` for a run and
`pnpm rehearse:sync` for a sweep; a script, never a command the CLI ships.
_Avoid_: demo, dry run — a dry run implies the real ports with side effects
off, and these are not the real ports; mock mode, simulation.

**Step tree**:
A run as its shape rather than its stream: a root per run, a node per step,
and under each node the events that happened while it was open. It is a pure
function of the run events and holds a list of roots, so one presenter over
many runs is the same tree with more of them. A sweep is one root whose
children are its rows, not a root per pull request: a sync worker has no
stages and emits no `run` event of its own.
_Avoid_: model, state — *view* is separately what the operator has selected
and folded, which is not the tree.

**Outline**:
The step tree folded: one line per step carrying its state, its title and
what there is to say about it — what it will do while pending, how long it
has been going while running, its summary once finished. The position is the
header's, not the row's. It is what a screen shows by default and what is
written to plain scrollback when a run leaves one.
_Avoid_: step list, overview, tree view.

**Title**:
What a row calls a step — `Implement`, `Pull request`, `Review loop` — where
the step's *name* is what the run calls it: the name keys the completed list,
the config and every plain line, and is never renamed for a reader. A title
travels on the `run` event and is only ever read.
_Avoid_: label, display name, pretty name.

**Summary**:
What a finished step came to, rolled up from the events that happened inside
it: how long, how much, how many tool calls by tool, which skills it invoked,
and each gate command's verdict. Derived, never emitted — no run event carries
one.
_Avoid_: rollup, stats, totals.

**Fold**:
Whether a step's own events are shown under its outline line. The running step
is unfolded and every other one is folded until the operator says otherwise; a
step folds itself when it ends unless they unfolded it by hand.
_Avoid_: expand, collapse, open, closed.

**View**:
What the operator has selected, unfolded and scrolled to. It is the step
tree's companion and the only thing on the screen a key press changes —
nothing on the keyboard can alter what the run does or how it ends.
_Avoid_: state, selection, mode.

**Window**:
The scrollable region under an unfolded step's outline line, showing that
step's own stream and, while that step is the running one, the liveness of an
open wait or gate.
_Avoid_: pane, viewport — a viewport is the whole of what a screen redraws;
the desktop window a capture may render is a different thing.

**Invoked skill**:
A skill the agent reached for inside a step, read off its `Skill` tool calls.
Distinct from the skills a session *loaded*, which are the same plugin list
every time and are reported nowhere.
_Avoid_: skill, loaded skills.

**Wait**:
A stretch in which the host is blocked on something it does not control — an
agent call, the reviewer, the PR's checks. A wait has a subject and sometimes
a deadline, and is what the live region animates to prove the run is alive. It
belongs to the node it opened in rather than to the tree, so a sweep's six
concurrent waits do not blank each other as they end.
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
a pass over the repository, never a process that stays alive watching it. On a
terminal it draws the same screen a run does, one row per pull request it
considered, and the counts line stays the last thing on stdout.
_Avoid_: watcher, daemon, monitor, poller — what invokes a sweep on a schedule
is the operator's, not fabrika's.

**Sync worker**:
One pull request's share of a sweep: its own worktree, run directory, gate and
agent session, run alongside a bounded number of others. It is a layer graph,
not a Claude sub-agent, and it shares nothing with its siblings but the
surface, which it reaches only through its own row.
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

### Showing the change

**Capture**:
A named command that renders one user-visible surface to files, run by the host
in a checkout. fabrika never looks inside what it writes, so the same contract
serves a simulator screen, a browser page, a window and a terminal frame.
Decided per run by one structured call under `pr.beforeAfter`, or pinned in the
committed config under `pr.capture`; the host runs it either way.
_Avoid_: screenshot — an image is one of the three kinds a capture may write;
snapshot, visual test.

**Capture plan**:
What a run does about a Before / After, decided from the config and the
branch's diff before anything is spawned or asked: nothing, the pinned
commands this diff touches, or ask. It is the whole of the `beforeAfter` and
`capture` table as one value, so every row of it is reachable without an
agent, a forge or a base commit anywhere near it.
_Avoid_: decision — that is the agent's answer when the plan says ask;
strategy, mode.

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
