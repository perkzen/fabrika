---
id: sync-screen
type: feat
---
# A sweep draws a screen: one row per conflicted pull request, unfolded to its transcript

A run an operator is watching gets the screen — an outline of steps, the
running one unfolded under its line, `↑↓` to select and `space` to fold. A
sweep, which is the command that most often has several things going at once
and nothing on the terminal to show for them, gets five lines of scrollback:

```
waiting for merge state of 1 pull request(s)
waited 3s for merge state of 1 pull request(s)
sync: 1 open pull request(s) you authored on perkzen/fabrika
sync: 1 conflicted, 0 skipped
waiting for syncing 1 pull request(s)
```

and then nothing at all until every worker has finished. What each worker is
doing — the merge, the conflicted files, the agent resolving them, the gate
after — is written to that worker's `log.txt` and nowhere else. `src/sweep.ts`
says so deliberately: the sweep gets `fileJournal.consoleOnly()` and each
worker `fileJournal.archiveOnly(placement.log)`, so six workers cannot fight
over one terminal. The cost of that decision is that the operator watching a
sweep is told less than the one watching a run, about work that is more
concurrent.

This ticket gives the sweep the same surface the run has: one row per pull
request the sweep selected, its state and summary on the row, its own stream in
a window when the operator unfolds it.

## What to build

`fabrika sync` on a terminal enters the alternate buffer, the way `fabrika run`
does, and draws:

- **A row per pull request the sweep considered**, in list order, with the
  skipped ones present and dimmed rather than absent — so the row count is the
  answer the scrollback's `N conflicted, M skipped` line gives. A row is
  titled short, `#42 FAB-5`; the pull request's own title and whose it is go in
  its detail, where there is room for them (see §1).
- **State per row**, from the sync outcome: `synced` and `already clean` read
  as done, `escalated` and `failed` as failed, `skipped` as skipped with the
  rule that skipped it as its detail. A row that has not been handed out yet is
  pending; several rows are running at once, which is the one thing the run's
  outline never has.
- **A window under the unfolded row** carrying that worker's own stream — the
  `worktree …` line, the install, `base moved: N commit(s) behind; merging`,
  the conflicted file count, the agent's speech and tool calls while it
  resolves, the gate after. This is the whole point of the ticket: what is in
  `log.txt` today becomes something the operator can watch as it happens.
- **The keys the run already has**: `↑↓` select, `space` fold, `PgUp/PgDn`
  scroll, `Esc` follow, `o` open, `^C` interrupt. `o` opens the *selected*
  row's worktree, not one path for the whole sweep — the trees that survive a
  sweep are the escalated and rate-limited ones, and each is somewhere else.
- **The exit scrollback** the screen already writes on the way out: the outline,
  then the sweep's counts line last.

## Constraints

- **`counts()` stays the last line on stdout.** That line is the contract a
  scheduled invocation is read through, and it must not move. It does have to
  change how it is emitted: a screen writes nothing after it mounts but the
  exit scrollback, so a `journal.log(counts(...))` string would vanish from an
  interactive sweep. It becomes the sweep's **`result` event**, whose plain
  rendering is its text verbatim and which the screen writes last on the way
  out — the same place a run's `done:` line comes from. Its `outcome` is
  `done` unless an outcome needs a human, which is the same condition the exit
  code already reads.
- **Piped output gains the step lines, and only those.** A journal is one
  fan-out and a run is either fully dressed or fully plain, so a piped sweep
  that emits `run` and `step` events gets their plain renderings — `steps: …`,
  `step 1/3: …`, `step …: done (12s)` — interleaved with the lines it writes
  today. `reported()` and `counts()` keep their exact wording. This is an
  honest widening of the piped output, not a break: the last line is the same,
  and the new lines are the ones a piped run already has.
- **The verdict is `isInteractive`, taken once**, the way `file-journal.ts`'s
  `layer` takes it. Not a terminal, `NO_COLOR`, `TERM=dumb`, CI: the scrollback
  console.
- **A dry run draws nothing.** It returns before the fan-out and promises to
  touch nothing; it keeps its scrollback lines.
- **`log.txt` stays the durable record.** Every worker keeps its `archiveOnly`
  archive. The screen mirrors those events; it does not replace them, and an
  event that reaches the screen must reach the archive unchanged.
- **A worker still shares nothing with its siblings but the console.** One
  worktree, one writer; nothing here makes a second thing write into a
  worker's tree, and nothing a key press does can change what a worker does or
  how the sweep ends.
- **`^C` keeps its meaning.** Raw mode stops the terminal raising `SIGINT`, so
  the screen raises it, and the fiber tree is interrupted — never a
  `process.exit`, which would preempt the finalisers that clean up the MCP temp
  files. A worker already in flight is not cancelled mid-merge.

## The work

### 1. The sweep is the run; a pull request is a step

Emit a `run` event from the sweep once the selection is made, whose steps are
the pull requests the sweep is about to touch: `name` the target's key,
`title` the short form a row is cut to, `about` what the dry run would have
said — `would sync <branch> into <base>`. Then a `step` `start` as a
worker is handed out and a `step` `end` (or `skipped`) as its outcome is
recorded, in the same place `reported(outcome)` is logged today.

Two naming decisions belong to this section. The row's **title** is padded to
the widest one and capped at `TITLE_MAX`, so it has to be short — `#42 FAB-5`,
or the target's key — and the pull request's own title belongs in the row's
`about` and its detail, where there is room for it. The header's **label** is
what the operator calls this sweep; `forge.repo` is what the first scrollback
line already names and is the obvious answer.

That is the whole of the shape work, because `stepped` attributes a `step`
event **by position** — `child.at === entry.at` — and so is already safe with
several steps running at once. `restated`, `fold`, `titleColumn`,
`outlineRow`, `windowRows`, the `View` keys and the exit scrollback all
operate on a root's children and need nothing.

The one thing that has to be decided here rather than inherited: two rows are
`running` at the same time, and the frame unfolds the running step by default
(`follow`). Pick one — the first running row, or the most recently started —
and make it the rule the tests assert, so a sweep of six does not flicker
between windows as workers start.

### 2. Attribution by key, which `streamed` does not have

`streamed` puts an event in "the one child whose state is `running`", and
`inRoot` always changes the last root. With one worker that is right by
construction; with six it is wrong for five of them. Everything that is not a
`step` event goes through `streamed` — strings, agent speech, tool calls, cost,
gate, wait — so this is the one genuinely new mechanism in the ticket.

An entry has to arrive addressed to a node. Two things must not happen:

- **Do not put a pull request's identity on the run event.** An event goes to
  that worker's `log.txt` too, and a worker's own log naming the worker on
  every line is noise. The codebase's idiom for a fact about the machine rather
  than about the run is that the *presenter is told* — `Tree.label` and
  `Tree.worktree` are both that, and both say why in a comment.
- **Do not let a worker reach the screen directly.** The sweep's composition
  root already builds each worker's layer graph; the address travels with the
  graph, not through a global.

So: the screen can hand out a presenter bound to a row, and the composition
root gives each worker's journal that presenter alongside its archive.
`RunJournal.extra` exists for exactly this shape; `archiveOnly` is the form
that does not take one, and giving it one is the smaller half of this change.

### 3. A wait and a gate are one per tree, and now there are six

`Tree.wait` and `Tree.gate` are single fields, and `take` clears the wait
whichever wait ended. Six workers, each with an open agent call and a gate,
will blank each other's liveness. This is the same defect
`.fabrika/tickets/parallel-run.md` finding 1 names at `src/domain/outline.ts:81`
for a single run's two concurrent waits — one fix serves both, and whichever
ticket lands first should make it: the open waits belong to the node they
happened in, not to the tree.

The sweep's own `waitFor(journal, "syncing N pull request(s)")` around the
fan-out **stays**. On a screen it is the root's wait and costs nothing; piped,
it is what arms the console's sixty-second heartbeat, and it is the only thing
a scheduled sweep prints while six workers write to their own archives.
Removing it would make a cron'd sweep silent for an hour.

### 4. What a row says, and where its tree is

The sync outcome already carries `worktree` and `log` for the rows that have
them, and `reported()` joins them into one line. On a screen those are the
unfolded row's to show and `o`'s to open — per node, not `Tree.worktree`,
which is one path for a whole sweep and wrong for every row but one.

The usage limit is a row state like any other: once a worker hits it the sweep
stops handing out new work, and every pull request that was never started
becomes a skipped row reading `usage limit hit — not started`. The row of the
worker that hit it keeps its worktree, which is the tree the operator comes
back to once the window resets.

Nothing about the scrollback rendering of an outcome changes: `reported()` and
`counts()` keep their wording, and the tests that read the last line keep
passing.

## Acceptance criteria

- [ ] `fabrika sync` on a TTY draws the outline: one row per selected pull
      request, skipped ones dimmed with their reason, and the counts line last
      in the exit scrollback.
- [ ] Selecting a row and pressing `space` unfolds it, and the window shows
      that pull request's own stream — install, merge, conflicted files, agent
      speech, tool calls, gate — and nothing from any other row.
- [ ] Several rows run at once and each one's events land under its own row. A
      scripted sweep with interleaved events from three workers proves it.
- [ ] `o` opens the selected row's worktree; a row with no tree does not offer
      one.
- [ ] `^C` interrupts the sweep rather than exiting the process, and the
      terminal is restored: alternate buffer off, cursor shown, raw mode
      released.
- [ ] Piped, `NO_COLOR`, `TERM=dumb` and CI get the scrollback console, with
      `counts()` the last line on stdout — emitted as the `result` event and
      rendered as exactly the text it is today. Tests that read the last line
      pass unchanged; tests asserting the full set of lines are updated for the
      `run` and `step` renderings a piped sweep now carries.
- [ ] A sweep whose worker hits the usage limit shows the pull requests it
      never started as skipped rows, and the exit code is still 3.
- [ ] `--dry-run` draws no screen.
- [ ] Every worker's `log.txt` still receives everything it receives today.
- [ ] The frame is driven by a scripted event list in the tests — no terminal,
      no clock of its own — the way `frame.test.ts` and `outline.test.ts`
      already drive a run's.
- [ ] `CONTEXT.md` gains or amends whatever term this settles; `sweep`,
      `sync worker` and `step tree` are the entries it touches.

## Blocked by

None — can start immediately. It overlaps `parallel-run.md` finding 1 at one
point (the tree's single open wait); whichever lands first makes that change
and the other rebases onto it.

## Notes

**Why the sweep is the run and not many runs.** The step tree holds a list of
roots, and both `src/domain/outline.ts` and the glossary reserve that list for
"a presenter over many pull requests". Read against what a root is — one per
run, with steps under it — the list is for many *runs*. A sync worker is not a
run: it has no stages, emits no `run` event, and is one flat stream. So this
ticket spends a root's children rather than the roots list, which is what makes
`stepped`, `fold`, the frame and the `View` keys work untouched. The list stays
reserved, the glossary line stays true, and nothing here forecloses a root per
pull request on the day a worker grows stages of its own.

**Where this would split, if it has to be two runs.** The seam is between §2
and the rest: the attribution mechanism — a per-row presenter and the address
travelling with the layer graph — is testable on its own with a scripted event
list and no screen in it. §1, §3 and §4 are the screen the operator sees. It
is written as one ticket because a presenter nobody draws is an interface with
no reader to check it against.

**Drafted without the quiz** — taken from the operator's own description of
what they wanted while watching a sync: each conflicted pull request selectable
and expandable to its transcript, the way a run's steps are.
