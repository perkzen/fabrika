<img src="https://raw.githubusercontent.com/perkzen/fabrika/main/docs/assets/icon-128.png" alt="" width="96" align="right">

# fabrika

[![npm version](https://img.shields.io/npm/v/@perkzen/fabrika?logo=npm&color=cb3837)](https://www.npmjs.com/package/@perkzen/fabrika)
[![CI](https://github.com/perkzen/fabrika/actions/workflows/ci.yml/badge.svg)](https://github.com/perkzen/fabrika/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@perkzen/fabrika?logo=nodedotjs&color=5FA04E)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@perkzen/fabrika?color=blue)](LICENSE)

A local software factory. A ticket goes in, a reviewed draft pull request
comes out.

fabrika drives the real `claude` binary on your existing Claude Code login.
No API keys, no containers, no custom auth. Every stage is a headless
`claude -p` run; the host machine does the verifying, merging and pushing.

```mermaid
flowchart LR
    T["Ticket<br/>markdown spec file"] --> S[spec]
    S --> P[plan]
    P --> I[implement]
    I --> A[refactor]
    A --> SE[security]
    SE --> R[review]
    R --> M["merge base<br/>open draft PR"]
    M --> L["review loop<br/>reviewer findings + CI checks"]
    L --> H["Human reviews<br/>and merges"]
```

## Status

Early. `init` and `run` work end to end up to the draft PR on a scratch repo,
including resume from saved state. The six-stage pipeline and the automated
review loop have not yet run on a real ticket. `sync` discovery and its dry run
have been exercised against a real repository; its workers have not. Expect
rough edges.

## Prerequisites

- Node and [pnpm](https://pnpm.io)
- The [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, logged in (`claude auth login`)
- The [GitHub CLI](https://cli.github.com) (`gh`), authenticated against the target repo
- Only for `review.provider: "cubic"`: the [cubic](https://cubic.dev) review bot installed on the target repo. A repo without one sets `"none"`, which `init` does on its own, and its runs are decided by CI alone
- Only to let a stage read Linear: the `linear-ro` MCP server registered once with `claude mcp add` (see [docs/internals.md](docs/internals.md)). fabrika itself holds no Linear key

## Quick start

Install fabrika once (needs Node 24 or newer):

```bash
npm install -g @perkzen/fabrika
```

Or run it without installing:

```bash
npx @perkzen/fabrika init
```

fabrika treats the current directory as the target repo. Its own skills ship
inside the package and load through `--plugin-dir`, so the target repo needs
nothing installed.

To drive the CLI from a Claude Code session, install the `fabrika` skill and
invoke it with `/fabrika` — it is user-invocable only, so it loads when you
ask for it and never on a model's own initiative:

```bash
npx skills add perkzen/fabrika@fabrika -g
```

To work on fabrika itself, clone it and run the CLI straight from source
(Node strips the types, so there is no build step in the loop):

```bash
git clone https://github.com/perkzen/fabrika.git && cd fabrika && pnpm install && node src/cli.ts --help
```

Then, inside the repo you want to work on:

```bash
fabrika init
```

This reads the repo before it writes `.fabrika/config.json`: the default
branch, the install command from your lockfile, and the gate — the checks CI
already enforces on a pull request, each one run once to prove it is green on
an untouched checkout. It prints where every step came from and what it
dropped, because a gate step that does not pass here would hand the agent
"fix it" for code it never wrote. It runs those commands in your checkout, so
expect it to install dependencies and leave whatever `build` normally leaves.

Read the gate, correct anything it guessed wrong, set the branch-name pattern
(`{user}` in it is your `git config user.name`, kebab-cased), and commit the
file. The gate for a repo belongs in that repo.

Run a ticket:

```bash
fabrika run --file .fabrika/tickets/login-timeout.md
```

It opens by asking which steps to run — every stage this repo configured,
plus the pull request and its review loop — with all of them selected:

```
┌  fabrika
│
◇ 7 steps in .fabrika/config.json
│
◆ Steps to run
│ ↑↓ move, space select, enter confirm
│
│ ) ● Select None (7/7)
│   ────────────────────
│   ● Spec
│   ● Plan
│   ● Implement
│   ○ Refactor
│   ● Security
│   ● Review
│   ● Pull request
│
│ Description
│ One agent session on refactor.md, then your gate until it passes.
```

Press enter for the whole run; clear what this ticket does not need. The row
at the top of the list takes or clears all of them. What you settled on stays
in scrollback as one line, and the run's own screen takes over from there.

The last log line of a clean run is the PR URL. If the run stops, rerun the
same command and it picks up where it left off.

Draft PRs wait for a human, and while they wait the base moves. When one goes
conflicted, sweep them:

```bash
fabrika sync --dry-run
```

```bash
fabrika sync
```

One pass over every open pull request you authored on this repository: the
conflicted ones that target your base and whose branch is not checked out
anywhere on this machine get their own worktree, run directory and agent
session, and are merged, gated and pushed. Everything else is reported with
the rule that skipped it — a pull request that is merely behind is left for
the human who is going to read its diff.

`--dry-run` prints exactly that selection and changes nothing; reach for it
first, because filtering by author deliberately includes your hand-written
branches. `--concurrency <n>` (default 2) is how many run at once. One line
per pull request on your console, each worker's full log in its own
`log.txt`, and the counts on the last line.

Before trusting a real ticket to it, run `pnpm smoke` in the fabrika checkout.
It proves the `claude` CLI behaviours the pipeline depends on.

## How it works

### Every code stage must pass your gate

The gate is the list of commands in your config. The host runs them after every
stage that changes code. The agent's own "done" is never trusted.

```mermaid
flowchart TD
    A[Agent runs the stage] --> B{Host runs the gate}
    B -- green --> C[Next stage]
    B -- red --> D[Failing output goes back to the agent]
    D --> E{Attempts left?}
    E -- yes --> A
    E -- no --> F[Escalate to a human]
```

### The PR is done when the reviewers are happy

After the draft PR opens, the host watches the reviewer and CI. The agent
only fixes.

```mermaid
flowchart TD
    A[Push draft PR] --> B[Wait for the reviewer and CI checks]
    B --> C{"Reviewer satisfied, no open threads,<br/>no failing checks?"}
    C -- yes --> Z[Ready for human review]
    C -- no --> D[Agent fixes or disputes each finding]
    D --> E[Host posts replies, merges base, runs gate, pushes]
    E --> B
```

A round takes one of two shapes. With `review.provider: "cubic"`, the host
waits for the bot's review of the pushed commit and the round turns on its
score, its open threads and the checks together. With `"none"` there is no bot
to wait for, so the reviewer is satisfied by construction and the round turns
on the checks alone: the host still waits for them to settle, still hands a
failing one's log to the agent that wrote the code, and still escalates after
`review.maxRounds`. The run finishes either way — it just claims no score it
did not seek.

A failed CI run is rerun once first, for flakes. The host never resolves a
thread the agent did not address.

### The PR shows the change, not only the diff

For the half of a change a diff cannot show, the pull request carries a
**Before / After** section: one command that renders a user-visible surface,
run by the host twice — in a checkout of the base, and on your branch — with
`$FABRIKA_CAPTURE_DIR` pointing at an empty directory it writes into. Images go
up as GitHub attachments, text is fenced, and nothing is committed.

It is `pr.beforeAfter` in your config, on by default:

```json
"pr": { "draft": true, "emptyCommit": true, "beforeAfter": true }
```

Nothing else to declare. Each run reads its own diff and works out whether it
changed a surface anyone looks at and what already renders it, so a branch that
touched only logic, tests or docs adds nothing to the PR. That decision is one
short agent call per run, made after the push.

On by default means new configs. `fabrika init` writes the key, but a config
written before this field existed does not have it and keeps the old behaviour
— add the line by hand to turn it on. A repository with no user-visible surface
never produces a section either way.

Set `pr.capture` instead when the render is expensive enough to be worth
pinning — a simulator boot, a full site build — and the named commands and
their globs take over. `"beforeAfter": false` turns the whole thing off.

Images need `gh` 2.99.0 or newer for `gh pr create --attach`; an older `gh`
keeps the text and says so in the log.

### Keeping the machine awake

A run is mostly waiting — on an agent call, on the reviewer, on CI — and a Mac
that goes to sleep takes every one of those waits with it. Set `keepAwake` and
the run holds the machine up for its own lifetime:

```json
{
  "keepAwake": true
}
```

macOS only: it is `caffeinate -dimsu` watching fabrika's own pid, so it stops
the moment the run does, whether that is a clean finish, an escalation or a
Ctrl-C. Off by default, because `.fabrika/config.json` is committed and this is
one machine's preference. On anything but macOS it warns once and runs on.

### Principles

- **Humans own both ends.** People write tickets and people merge PRs. No auto-merge, no writes to the ticket tracker.
- **Invariants are mechanism, not prose.** `git push`, `gh pr merge` and thread resolution are denied to the agent through Claude Code's tool rules. The host does them.
- **Unattended means recorded.** No stage can ask a question. Where a skill would normally ask, it decides and writes the decision down, so the human reviews a list of assumptions rather than a mystery.
- **Stages are data.** Adding a stage is one entry in the config, not code.
- **Method lives in skills.** Each stage prompt is a few lines naming a `fabrika:<skill>`. fabrika ships the skills itself, so a target repo needs nothing installed.
- **Small commits.** One commit per red-to-green cycle, one per finding fixed.

## Tickets

A ticket is a small record — an identifier, a title, a description — and it is
always a local markdown file. Linear reaches a run through the `linear-ro` MCP
server a stage declares, not through a key fabrika holds: the agent reads the
issue, its comments and its linked issues itself, and the `linear:` frontmatter
below is what puts the identifier on the branch and the URL on the PR.

A spec file is markdown with optional frontmatter:

```markdown
---
id: login-timeout   # optional; default: the filename stem
type: fix           # optional; feat | fix | chore, default feat
linear: PAR-412     # optional; becomes the identifier and links the branch
---
# Login times out on slow networks

<the spec>
```

The `fabrika:to-tickets` skill can split a larger spec or conversation into
such files under `.fabrika/tickets/<feature>/`, so a feature becomes runnable
tickets without touching your team's Linear.

## Stages

The default pipeline, and what the select offers. Each stage writes its
artifact to `.fabrika/work/` in the worktree, and the whole folder is copied
next to the run's logs when the run finishes.

| Stage | Skill | Output |
| --- | --- | --- |
| spec | `fabrika:to-spec` | `spec.md` with problem, solution, user stories and recorded assumptions |
| plan | `fabrika:plan` | `plan.md` with ordered vertical slices and decisions from a self-grill |
| implement | `fabrika:implement`, `fabrika:tdd` | code, one commit per red-to-green cycle |
| refactor | `fabrika:improve-codebase-architecture` | `refactor.md`, refactor commits scoped to the branch |
| security | `fabrika:security` | `security.md`, High and Medium findings fixed |
| review | `fabrika:code-review` | `review.md` and `pr.md`, which becomes the PR body |

Review rounds use `fabrika:tdd` for fixes, `fabrika:fix-ci` for failing
checks, and `fabrika:resolving-merge-conflicts` when merging the base
conflicts. See [skills/README.md](skills/README.md) for every skill and what
it reads and writes.

The skills are adapted from [Matt Pocock's skills](https://github.com/mattpocock/skills)
(MIT), with the interactive checkpoints replaced by recorded decisions.

## Where things live

- `.fabrika/config.json` in the target repo: base branch, branch pattern, gate, stages, `model` (per stage, or one for the whole run), denied tools, review settings, `keepAwake`, Before / After
- `~/.fabrika/worktrees/<repo>/<ticket>/`: the worktree for a run
- `~/.fabrika/runs/<repo>/<ticket>/`: `state.json`, `log.txt`, raw agent transcripts, and the copied `work/` artifacts
- `~/.fabrika/captures/<repo>/<base sha>/`: the base half of each capture, keyed by name and command, reused by every ticket cut from that commit

fabrika stores no credentials of its own: `claude`, `gh` and each MCP server
hold theirs. The one thing it reads from the environment is
`FABRIKA_EDITOR` — `FABRIKA_EDITOR="open -a WebStorm"` in your shell — the
editor the screen's `o` opens the worktree in; on macOS it falls back to
`open`.

For source layout, exit codes, MCP and Linear setup, the smoke test and other
operator notes, see [docs/internals.md](docs/internals.md).

## Deliberately not doing

Containers. Custom auth or OAuth handling. Parallel multi-agent fan-out.
Auto-merge. Ticket-tracker writes.
