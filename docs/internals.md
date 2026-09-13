# Internals

Operator and contributor notes. The [README](../README.md) covers what fabrika
is and how to run it; this file covers how it is built.

## Source layout

A run is a pipeline of steps over a set of ports. Each port is an interface
with one adapter in production and an in-memory one in the tests; nothing in
`pipeline/` knows which is behind it. The top of `src/` is the three commands
and what every folder shares — the config, the errors and the paths. Under it,
`domain/` is the pure models, `ports/` the interfaces, `adapters/` their
production implementations, `pipeline/` the steps and the driver, `terminal/`
the presenters and the terminal they are drawn on, and `infra/` the subprocess
plumbing the adapters and the commands sit on. Nothing in `terminal/` reaches
into `infra/`: a presenter never spawns anything, which is what keeps the
terminal testable without a machine behind it. Nothing in `terminal/` reaches
into `pipeline/` either — what a run may be asked to leave out is a fact about
the config, in `domain/choices.ts`, so the select draws its rows without
building a step to read a title off.

| Path | Role |
| --- | --- |
| `src/cli.ts` | `fabrika init` / `fabrika run --file <spec>` / `fabrika sync`; auth probe; exit codes |
| `src/run.ts` | The composition root: which adapter is behind each port, then run the pipeline |
| `src/sweep.ts` | The sweep's composition root: one console, a forge with no worktree, and a layer graph per pull request |
| `src/config.ts` | `Schema` for `.fabrika/config.json`; the `init` template, neutral where the values are repo-specific; the two halves of `base` |
| `src/configure.ts` | The `init` call: schema, the validator that rejects an unusable answer, and the guard that keeps `git push` out of a gate step |
| `src/errors.ts` | `FabrikaError`, the one error every port speaks, and the mapping from an adapter's own failure onto it |
| `src/paths.ts` | The paths fabrika resolves: the package's own, so the lookup works from `src/` and from `dist/`, and the operator's `~/.fabrika` |
| `src/domain/ticket.ts` | The `Ticket` record, the slug rules and the branch pattern |
| `src/domain/pull-request.ts` | The title and the trailer fabrika writes into a pull request it opens, and how a sweep reads both back |
| `src/domain/captures.ts` | The `Shot` and `CaptureFile` types and `beforeAfter()`, the pure rendering of the PR body's Before / After section — every shape it can take is reachable from a plain call; plus `capturePlan()`, the whole `beforeAfter` × `capture` table as one function, and `asCaptureDecision()`, the rules a per-run capture answer is held to |
| `src/domain/choices.ts` | What a run may be asked to leave out: the configured stages and the pull request, each with the title and the words a row shows. Pure over the config, so the select and `--steps` read it without reaching into `pipeline/` |
| `src/domain/run-event.ts` | The `RunEvent` union and `plain()`, its ANSI-free rendering — what the archive gets, and what a console gets for every kind but agent speech; `stamp`, `elapsed` and `gateOver` live here, so both surfaces read one definition |
| `src/domain/outline.ts` | The step tree: a root per run, a node per step, and each step's summary folded out of the events that happened inside it. Pure — no `effect`, no terminal — so a screen is a function of a scripted event list |
| `src/ports/` | `Agent`, `Workspace`, `Gate`, `Forge`, `Captures`, `Reviewer`, `TicketSource`, `Prompts`, `RunStore`, `Journal`, `RunContext` |
| `src/adapters/` | Claude, git worktree, shell gate, shell captures, `gh`, cubic, no-reviewer, a spec file, the run directory |
| `src/adapters/file-journal.ts` | Which surfaces a run reports to, decided once: the screen when an operator is watching, the scrolling console otherwise, and `log.txt` under both. A sweep and `init` ask for `consoleOnly`, which never draws a screen and keeps no archive; a sweep's worker asks for `archiveOnly`, which writes `log.txt` and never touches the terminal |
| `src/pipeline/step.ts` | The `Step` type, the builder that orders steps, and the driver that runs them and resumes. The driver ends every step it starts and owns the run's `result` line, so the PR URL is the last stdout line of a clean run |
| `src/pipeline/fabrika.ts` | The run fabrika ships: preflight, branch, workspace, the configured stages, PR, review |
| `src/pipeline/steps/` | One file per step |
| `src/pipeline/sync.ts` | The base merge the PR step, the review loop and a sweep's worker all use |
| `src/pipeline/install.ts` | The dependency install and the two lines it can end on, so the run's workspace step and a sweep's worker say it the same way |
| `src/pipeline/sweep.ts` | The fan-out: handing work out under a concurrency bound, turning a worker's failure into a value, and the exit code |
| `src/pipeline/sweep-selection.ts` | Which pull requests a sweep may touch, and why it left the rest alone — six rules, first match wins |
| `src/pipeline/sweep-report.ts` | What the operator reads: one line per pull request, and the counts line a scheduled invocation is read through |
| `src/pipeline/sync-worker.ts` | One pull request's share of a sweep: its own tree, checked out as the forge has it, merged, gated and pushed |
| `src/terminal/surface.ts` | The terminal every surface is drawn on: the interactivity verdict, `Style` and `Styler`, the dressing, the size, the cursor sequences and the loop that reads raw stdin into keys. Under the presenters, so a screen, a console, a select and a banner share one of each rather than four |
| `src/terminal/console.ts` | The scrollback console presenter: the live region and the frame timer. The walk from an event to dressed lines is `lines.ts`'s |
| `src/terminal/lines.ts` | Every line both live surfaces share: `display()` — one run event as the dressed lines a reader sees, with the colour table, the gutter on agent speech, the markdown walk and the height cap if the surface asks for one — and `progressRow` / `livenessRow` / `spinner`, the run's progress, whatever is blocking it and the frame anything turning is on, drawn once so the console and the screen cannot drift |
| `src/terminal/screen.ts` | The screen presenter an interactive run gets: the inner console until the first `run` event, then the alternate buffer, the frame timer, raw-mode keys, SIGINT, resize, and the folded outline written to scrollback on the way out |
| `src/terminal/frame.ts` | `frame()` — a tree and a view into exactly `rows` lines of at most `columns - 1`: the header and, under it, the worktree's path in `~` form, the step line and its summary, the open step's window, the wrap and the cut. `layout()` is the row budget it and `keys.ts` both spend, `scrolled()` the clamp that keeps a page key inside the window, and `outlineRows()` the outline alone, for the scrollback a screen leaves behind |
| `src/terminal/keys.ts` | `decode`, `press` and `follow` — a keystroke and a view in, a view out. Pure, so the keyboard is tested without a terminal |
| `src/terminal/select.ts` | The question `run` opens with: a pure key table, a pure render to lines and a thin driver over the keyboard |
| `src/terminal/banner.ts` | The wordmark `run` and `init` open with, written before any presenter exists; interactive-only, one-line where the block will not fit |
| `src/terminal/archive.ts` | The presenter for `log.txt` — the plain rendering, stamped per physical line, uncapped |
| `src/terminal/markdown.ts` | `marked`'s lexer walked into styled lines, the same walk in both terminal modes |
| `src/infra/claude.ts` | The Claude Code CLI as a subprocess: the credential contract, the plugin flag, the stream-json walk |
| `src/infra/transcript.ts` | An assistant message's content blocks into run events, and what one tool call is about |
| `src/infra/mcp.ts` | Claude Code's own MCP config as the registry a stage's `mcp` array is resolved against |
| `src/infra/shell.ts` | The subprocess helper, the detached fork, and the environment minus its credentials |
| `src/infra/editor.ts` | `editorOpener()` — `FABRIKA_EDITOR` and the platform into the opener the screen's `o` calls, already bound to the worktree, or nothing where there is no default worth guessing |
| `src/infra/keep-awake.ts` | The `caffeinate` assertion that holds the machine up for as long as the process lives |
| `prompts/` | Stage prompts and per-stage system prompts, `{{title}}`-style substitution |
| `skills/` | The `fabrika:*` skills each stage prompt names; `.claude-plugin/plugin.json` is the manifest |
| `test/harness.ts` | Every port in memory, so a step can be exercised with no repository, no GitHub and no agent |
| `scripts/smoke.ts` | CLI behaviour checks against the real `claude` (see below) |
| `scripts/capture-console.ts` | This repo's own capture: a fixture of run events replayed through the console presenter (see below) |

### Changing a piece of it

- **A different reviewer, code host or agent** is a different adapter and one
  line in `src/run.ts`. The ports are what the steps are written against, so
  nothing in `pipeline/` moves.
- **A different run** — an extra step, a different order, a step dropped — is
  the builder in `src/pipeline/fabrika.ts`: `.step()`, `.steps()`, `.replace()`
  and `.without()` return a new builder each time.
- **A step marked `once`** is recorded in `state.json` and skipped when a run
  resumes; a step that answers its `skip` with a reason is not recorded, so the
  reason is reconsidered next time.

Built on [Effect](https://effect.website) 4.x (release candidate), whose core
package carries the filesystem, path and CLI modules; subprocesses come from
`effect/unstable/process` and the Node bindings from `@effect/platform-node`.

## What a run looks like

An interactive `fabrika run` is a **screen**: the terminal's alternate buffer,
with a header carrying the ticket, the progress bar, the step the run is on
and what the run has taken so far in time and money, the worktree's path on
the row under it, then one line per step from `Preflight` to `Review loop`.
A step's line is its title and, after it, what there is to say: a pending
step says what it will do (`agent · gate`), the running step says how long
it has been at it and is unfolded under its line, and a finished step says
how long it took, what it cost, how many tool calls it made and by which
tool, which skills it invoked and each gate command's verdict — time and
cost in columns, so the rows read as a table. Steps are titled by the
pipeline (`title` on a `Step`; a stage's is its name capitalised) and named
by the run: the name is what the completed list, the config and every plain
line say, and a title never replaces it.

The keys are `↑↓` (or `k`/`j`) to move the selection over the steps that
have run, space or enter to fold and unfold it, `PgUp`/`PgDn` to scroll the
open window, `Esc` to go back to following the running step, `o` to open the
worktree in `FABRIKA_EDITOR`, and `Ctrl-C` to interrupt the run. They are
optional: a run whose operator went home has the same outcome, the same exit
code and the same last line, and one who pressed `o` has an editor open
beside a run that is otherwise identical. Leaving the screen — on every exit
path — writes the folded outline, the worktree's absolute path and the
result line to plain scrollback.

A pipe, `NO_COLOR`, `TERM=dumb`, CI and `fabrika init` get the scrolling log
instead, unchanged but for one `step refactor: done (8m 53s)` line per step.
`log.txt` is the same, plain, stamped and uncapped. ADR-0004 records why the
screen is hand-rolled rather than built on a framework.

To look at any of it without a ticket, `pnpm rehearse` opens with the same
nameplate and the same select `fabrika run` does, then runs what was chosen
on the test harness's in-memory ports — no `git`, `gh` or `claude`, nothing
under `~/.fabrika` — with a scripted agent, a gate that goes red once and a
reviewer that opens one thread before signing off, paced like a run;
`pnpm rehearse --fast` is the same run in seconds, and a pipe gets every step
with nothing asked. Clear a stage to watch an outline that never had it.
It is `scripts/rehearse.ts`, and it does not ship.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Clean run; the last log line is the PR URL, or for `sync` the counts line |
| 1 | Configuration or CLI error |
| 2 | A human needs to look: a run escalated, or a `sync` worker escalated or failed. The worktree and PR (if any) are left in place; rerun to resume |
| 3 | Claude usage limit hit; state is saved, rerun once the window resets |
| 130 | `^C` — at the select, before anything ran, or during the run |

## Why the CLI is installed rather than run via a package manager

fabrika reads the *current* directory as the target repo. `pnpm --dir` would
move the working directory to fabrika's own checkout, so the CLI is installed
globally (or run with `npx`) and invoked from inside the target repo.

## Why the package ships `dist/`

Node strips types from `.ts` files, so `node src/cli.ts` runs the CLI straight
from a checkout with no build. It refuses to do so for files under
`node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the
published package ships compiled JS: `tsconfig.build.json` emits to `dist/`
with `rewriteRelativeImportExtensions`, which turns the `./foo.ts` specifiers
into `./foo.js`. `dist/` sits at the same depth as `src/`, so the `new URL("..",
import.meta.url)` lookups for `PLUGIN_DIR` and `PROMPTS` resolve to the package
root either way. `erasableSyntaxOnly` in `tsconfig.json` keeps the from-source
path working by failing the typecheck on syntax Node cannot strip.

## Configuring a repo

`fabrika init` writes the template in `src/config.ts`, but `base`, `install`,
`gate` and `capture` are left neutral there and filled in by one structured
call that applies the `fabrika:configure` skill. They are the fields that
cannot be shipped: a gate step naming a script the target repo does not have goes red on
an untouched checkout, and the runner hands that failure to the agent as
"fix it" for code it never wrote — so the agent spends `maxIterations`
inventing a way to make a command that should not be there pass.

The call reads the repo's CI workflows first and its scripts second. CI is the
ground truth because the review loop waits on the PR's checks: a gate that
differs from CI goes green on the host, pushes, and spends a review round on a
mismatch that was readable at init. It then **runs each candidate** on the
untouched checkout and proposes only the green ones, which is the part a
template or a regex cannot do, and returns a `notes` line per decision that
`init` prints.

The host still writes the file. `asProposal` in `src/configure.ts` rejects an
answer whose parts are unusable, and rejects any gate step containing
`git push`, `gh pr merge`, a publish or an `rm -r`: the config denies those
tools to every stage, and a gate command is the one place that rule could be
laundered back in. A rejected or failed call — including `claude` missing from
PATH — leaves `gate` empty and says so. An empty gate is honest; a wrong one
is not.

## Branch naming

The branch pattern in the config fills `{user}`, `{type}`, `{ticket}` and
`{slug}`. `{user}` is `git config user.name`, lowercased and kebab-cased
(`Domen Perko` → `domen-perko`): the config is committed to the target repo, so
the prefix has to be whoever is running rather than a baked-in name, and a
pattern that asks for `{user}` where git has no `user.name` stops the run with
that message. `{ticket}` is the ticket's identifier; the type and slug come
from one short structured call at the start of the run that applies the
`fabrika:branch-naming` skill (terse slug, type from labels or wording). The same call decides whether the change has a
browser-visible surface; if so `previewPrefix` (`preview/` by default, the
prefix Vercel's Ignored Build Step lets through) goes in front. An answer that
breaks the naming rules is replaced by the deterministic parts. The chosen name
is saved in `state.json` so a resume lands on the same branch.

## MCP servers and Linear

MCP servers come from Claude Code's own config (`claude mcp add …`); a stage
names the ones it wants in its `mcp` array. Remote servers must carry a static
`Authorization` header, because OAuth-backed servers cannot re-authenticate
unattended.

A ticket is always a markdown file and its body is inlined into the spec
prompt, so a run needs no Linear at all. The `linear-ro` server is how a run
reaches Linear when it should: a stage that names it can read the issue, its
comments and its linked issues, which is the part a file cannot carry. Register
a read-only key once, user-scoped:

```bash
claude mcp add -s user --transport http linear-ro https://mcp.linear.app/mcp \
  --header "Authorization: Bearer <a Linear read-only API key>"
```

The key lives in Claude Code's own config from then on; fabrika never reads it,
loads no `.env`, and so has no Linear secret to leak into a worktree or a
capture. The default `spec` stage declares `mcp: ["linear-ro"]` — a repo whose
config drops it gets no Linear tools in that stage, and the spec is written from
the ticket file alone.

## Run state

Each run keeps its state and logs outside the target repo, in
`~/.fabrika/runs/<repo>/<ticket>/`:

- `state.json`: session ids by key, completed stages, branch name, ticket type, PR number, review round
- `log.txt`: the human-readable log
- one raw `stream-json` file per agent call
- `work/`: a copy of the worktree's `.fabrika/work/` made when the run finishes

One directory more is keyed by base commit rather than by ticket, because that
is what its contents depend on:

- `~/.fabrika/captures/<repo>/<base sha>/<capture>/`: the base half of a
  capture, so ten tickets cut from one base pay for one run of it. Nothing
  evicts it; deleting it costs the next run a recapture and nothing else.

Rerunning the same command resumes from that state. On escalation the worktree
is left in place for a human.

`.fabrika/work/` is kept out of git through the target repo's
`.git/info/exclude` (shared by its worktrees), so the stage artifacts never
land in a commit but survive the worktree.

## Choosing the steps

Which steps a run contains is decided once, before the pipeline is built:
`--steps spec,plan,implement`, or — on a terminal with nobody piping it — the
operator's answer to the select that opens the command, with everything
selected. The select is hand-rolled for the reason ADR-0004 gives for the
screen: `src/terminal/select.ts` is a pure key table, a pure render to lines and
a thin driver, so it is tested on whole lines. It draws a rail — the chip,
the config it read, the question, the list, and one line of description for
whatever row the operator is standing on — and leaves one settled row behind
when it is answered. A pipe, `NO_COLOR`, CI and any shell an agent drives run every
step, because a run nobody can answer must not stop on a question.

The choices are this repo's stages, in their configured order, plus
`pull-request` for the draft PR and the review loop together — one choice
because the loop's rounds are keyed by the PR's number, and because the
loop's step shares the `review` stage's name.

A deselected step is left out of the pipeline rather than skipped inside it,
so `steps` on the run event, the outline and the `n/of` counter all describe
the run that was asked for. `preflight`, `branch` and `workspace` are never
offered: a run with no worktree has nowhere to do anything.

A stage nobody in the repo ever wants is deleted from `stages` instead.

## One session per stage

Each stage gets its own Claude session, so the implementer never inherits the
spec conversation and the reviewer reads the code cold. What travels between
stages is `.fabrika/work/` and the commits — written down, not remembered.

Within a unit of work the session is reused, which is what makes a gate retry
work: the agent being told "compile failed, fix it" is the one that wrote the
code. The keys in `state.sessions`:

| Key | Covers |
| --- | --- |
| `branch` | the naming call |
| the stage name | the stage and its gate-failure retries |
| `merge-<round>` | resolving a base merge, and the repair pass after it |
| `round-<round>` | one review round: review threads, CI fixes, the repair pass |
| `sync-<base tip>` | one sweep's merge of a pull request, keyed by the first 7 characters of the base's tip |

A stage that assumes it remembers an earlier one is a bug in its prompt — the
inputs have to be named as paths.

`sync-<base tip>` is the sweep's, and it is read off the live base after the
fetch rather than off the pull request: it cannot collide with a round
counter, and it changes exactly when the thing being merged changes. A retried
sweep against an unmoved base lands in the session that already saw the
conflict; one months later does not.

## Sweeping conflicted pull requests

`fabrika sync` is one **sweep**: a single `gh pr list` names every open pull
request you authored with its **merge state**, and the conflicted ones that
target the configured base and whose branch is not checked out anywhere on
this machine are handed to bounded-concurrency **sync workers**. Everything
else is reported with the rule that skipped it, first match wins:

1. not open — `closed` / `already merged`
2. headed from a fork — nothing here can push to it
3. targets another branch
4. merge state unknown — GitHub would not compute it
5. not conflicted (`behind` or `clean`)
6. the branch is checked out somewhere, with where

A worker checks the branch out **as the forge has it** — a fetch and a hard
reset, ADR-0004 — installs, merges the base through the same `syncWithBase`
a run uses, gates, pushes and removes its tree. No review rounds and no forge
call: the reviewer has already ruled, and a merge commit is not a new
implementation. An escalation leaves its worktree exactly as an escalated run
does.

Rule 6 and the hard reset are load-bearing for each other: the reset is safe
only because a branch checked out on this machine never reaches a worker. Rule
6 reads `git worktree list` once, before the fan-out, so it fences one sweep
and not two — `checkout` therefore makes its tree and never reuses one, and a
second sweep that finds a worktree already there refuses that pull request
rather than resetting over the first sweep's merge.

The last line is the contract a scheduled invocation is read through, and it
carries five counts in this order:

```
sync: 1 synced, 0 already clean, 1 escalated, 0 failed, 5 skipped
```

`already clean` is its own field rather than folded into `synced`: the pull
request was conflicted when GitHub was asked, so a merge that found nothing to
do is a fact worth reporting rather than a push that did not happen. A sweep
with nothing to do says so instead — `none conflicted` when none were, and
`every conflicted one skipped` when they were skipped by the rules above.

The sweep owns the only console — one line per pull request, the counts last
— and each worker's journal is its `log.txt` alone, appended to the original
run's log when the scan of `~/.fabrika/runs/<repo>/*/state.json` found one.
The usage limit is the one failure that stops the sweep: workers already in
flight run to their own outcomes, workers not yet started report
`usage limit hit — not started`, and the exit code is 3.

## Review loop details

After the draft PR opens, each round:

1. waits for the configured reviewer's review of the pushed commit — immediate
   under `review.provider: "none"`, which reviews nothing
2. reads open review threads (none under `"none"`), and the PR's checks for that commit
3. reruns a failed Actions run once, for flakes
4. hands threads and failed-step logs to the agent, which fixes or disputes each one
5. posts the replies, resolves only threads the agent addressed, merges the base branch again, runs the gate, pushes

Done depends on the provider. Under `"cubic"`: the score is at least
`review.requireScore`, no threads are open, and no check on the pushed commit
is failing. Under `"none"`: no check on the pushed commit is failing — there is
no verdict to satisfy, so the loop neither waits for one nor claims one in the
done line. After `review.maxRounds` rounds the run escalates either way.
Merging (never rebasing) keeps pushed commits in place so cubic's per-commit
reviews stay valid.

The loop reads `Reviewer.scores` rather than the config field, so a third
review bot is a new adapter and one more arm of the ternary in `src/run.ts`.
ADR-0002 records why the port carries inert stubs instead of being split.

## Before / After on the pull request

A **capture** is one named command. The host runs it twice — in a detached
checkout of the base and in the run's own worktree — with
`FABRIKA_CAPTURE_DIR` pointing at an empty directory, and reads back whatever
files it wrote. fabrika never looks inside one, which is why a simulator
screen, a browser page and a terminal frame need no change here.

Who decides the command is `pr.beforeAfter`:

| `beforeAfter` | `capture` | What happens |
| --- | --- | --- |
| `true` | absent | One structured call at the pull request reads the branch and answers whether it changed a surface and what renders it |
| absent | set | The pinned commands, gated by their own globs against the diff |
| `true` | set | The pinned commands; a human already decided, so nothing is re-decided |
| `false` | either | Nothing, whatever the config still lists |

`true` is the template's default and the better one. The globs are a cached
judgement about which files render which surface and nothing invalidates that
cache — add an import to a rendering module and the capture quietly stops
firing on branches that do change the surface. The call reads the diff instead,
which is where that judgement can actually be made. `pr.capture` stays for the
repo whose render is a simulator boot or a full build, where the command is
worth reviewing rather than re-choosing every run.

The answer is a command the *host* spawns, with no permission layer in front
of it, so `asCaptureDecision` believes it only where it is safe to act on: the
name is decoded through `CaptureStep` because the host makes a directory of it
and empties that directory recursively, and the command is held to `FORBIDDEN`
because `deny` gates the agent's subprocess and not this. A rejected answer is
no section, never a failed run. ADR-0006 records the split.

The base half is cached under `<name>-<hash of the command>`, not the name
alone: a run that decides its own command can bring a different one under the
same obvious name, and pairing this branch's after against that one's before
compares two commands rather than two revisions.

Kinds are decided by extension: `.png` `.jpg` `.jpeg` `.gif` `.webp` are
uploaded with the pull request and shown side by side, `.txt` is scrubbed,
capped and fenced, `.url` becomes a link, and anything else is ignored. The
uploading is `gh pr create --attach`, which arrived in `gh` 2.99.0; an older
`gh` drops the images and says so, because a capture may never fail a run —
a non-zero exit, a timeout, an overrun cap or an empty directory all end as a
missing half and today's body. ADR-0003 records why the images are attachments
rather than anything committed.

This repo's own capture is `scripts/capture-console.ts`, which the call finds
for itself: `.fabrika/config.json` sets `beforeAfter` and names no command. It
replays a fixture of run events through the console presenter rather than
running a ticket, and writes a PNG through whatever `freeze`-class tool is on
`PATH`, or a `.txt` when there is none. It renders the console, not the
screen — a branch that only changes the alternate buffer has nothing here to
show, and a second script would be a second capture.

## Tests

```bash
pnpm test
```

`node --test` over `test/*.test.ts`, no test dependency. The tests run the
real steps against `test/harness.ts` — every port in memory — so they cover
the gate-retry loop, the review loop's done condition under both providers —
including a round with no reviewer, which runs the shipped no-reviewer adapter
rather than a double — the rule that a thread is resolved only when a commit
touched its file, and the one-rerun-per-flake behaviour, in milliseconds and
with no network.

A sweep is exercised through the same harness. `sweep` is handed a scripted
worker that genuinely *fails* where the case calls for one, so the
failure-to-outcome conversion under test is the real one; `syncPullRequest`
is exercised like any other step, and `syncWithBase` has its own file. The one
exception is `checkout`, which `test/checkout.test.ts` drives against two real
temporary repositories: it is the only test here that spawns git, and it is
worth the dependency because what it pins — that the hard reset never reaches
a tree fabrika did not just create — is a question about git rather than about
the ports. The push is still pinned at the port and not against git.

## Smoke test

```bash
pnpm smoke
```

Spawns a few short `claude -p` runs and checks that a tool call executes, a
deny rule holds under `--dangerously-skip-permissions`, `--resume` carries
context across directories, `--json-schema` returns structured output on a
call that also sets `--model`, and the `fabrika:*` skills load on both fresh
and resumed sessions. Run it before trusting anything else.

`--model` is here for the half a test cannot reach. That fabrika *passes* the
flag is covered in `test/claude.test.ts`, which spawns through a fake
`ChildProcessSpawner` and reads the argv it was handed. That the real binary
*accepts* the value is what only a real call can say, and this is the run that
says it.

## Migrating an old config

A `.fabrika/config.json` written by an older `init` has a three-stage list.
Run `fabrika init` in an empty directory and copy the `stages` array out of the
file it writes — `src/config.ts` holds the same template as a TypeScript object
now, which is not valid JSON. That is also where `only` shows up, if the
upgrade is what brings you here.
