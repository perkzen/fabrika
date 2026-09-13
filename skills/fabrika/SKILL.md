---
name: fabrika
description: Drive the fabrika CLI from an agent session — configure a repo, run a ticket into a reviewed draft pull request, sweep the open ones, and read a run that stopped. Use for /fabrika.
disable-model-invocation: true
argument-hint: "init | run <ticket.md> [steps] | sync [--dry-run] | the state of a run"
---

# fabrika

fabrika turns a ticket file into a reviewed draft pull request. Each stage is
a headless `claude -p` run in a worktree outside the checkout; the host runs
the gate, opens the PR and pushes. You are driving that host, not doing the
work yourself — do not implement the ticket, do not push, do not merge.

**Never run this from inside a fabrika stage.** If `.fabrika/work/` exists in
the working directory, you are the agent in a run, and starting another one
nests a factory inside itself. Stop and say so.

## Before anything

The current directory is the target repo — fabrika reads it, never a
`--dir` flag. Check, in this order, and stop at the first thing missing:

```bash
fabrika --version || npx -y @perkzen/fabrika --version   # Node 24+; install: npm i -g @perkzen/fabrika
claude auth status && gh auth status                     # both must be logged in
cat .fabrika/config.json                                 # else `fabrika init` first
```

Every `fabrika` below works as `npx -y @perkzen/fabrika` when it is not
installed. `claude auth status` can say logged in while the token is stale;
fabrika makes one live call of its own before every run and fails with
`run \`claude auth login\`` when it is, so take that message at its word
rather than re-checking the status.

## init

```bash
fabrika init
```

One agent call reads the repo and writes `.fabrika/config.json`: base branch,
install command, and the **gate** — the commands the host runs after every
stage that changes code. It runs the candidate commands in the checkout, so it
installs dependencies, leaves build output, and takes minutes.

Then read the gate back to the user before they commit the file. A gate step
that is already red on an untouched checkout hands the agent "fix it" for code
it never wrote and burns the run. An empty gate is better than a wrong one.

## run

A ticket is a markdown file with optional frontmatter — `id`, `type`
(`feat`/`fix`/`chore`), `linear: PAR-412` — and the spec as the body. The
`fabrika:to-tickets` skill splits a larger spec into runnable ones under
`.fabrika/tickets/`.

```bash
fabrika run --file .fabrika/tickets/login-timeout.md --steps spec,plan,implement
```

**Always pass `--steps`.** On a terminal the command opens a select; from your
shell there is nobody to ask, so an omitted flag runs *everything* — through
the draft PR and its review loop. Name the steps the user asked for. The names
are this repo's `stages[].name` in `.fabrika/config.json` (shipped default:
`spec`, `plan`, `implement`, `refactor`, `security`, `review`) plus
`pull-request`, which is the PR and its review loop together. An unknown name
is a CLI error that lists the real ones, so a typo costs nothing.

A run takes minutes to hours — it waits on agent calls, on CI and on the
review bot — so it outlives any foreground command you can hold open. Detach
it, and keep its exit code where you can read it later:

```bash
nohup sh -c 'fabrika run --file <ticket.md> --steps <names>; echo "fabrika exit $?"' \
  > ~/.fabrika/last-run.out 2>&1 &
```

Then poll, minutes apart, not seconds:

- `~/.fabrika/last-run.out` — the run's own stdout and stderr. Its last line is
  `fabrika exit <code>` once the run is over, and an escalation prints
  `ESCALATED: <reason>` here and nowhere else.
- `~/.fabrika/runs/<repo>/<key>/log.txt` — the narrative, uncapped and stamped.
  `<repo>` is the checkout directory's own name; `<key>` is the ticket's
  identifier.

The last stdout line of a clean run is the PR URL. Report it and stop; the
human merges. (Claude Code's own background Bash mode does the same thing —
`nohup` is here because this skill also installs into agents that have no such
mode.)

### When it stops

| Exit | What it means | What to do |
| --- | --- | --- |
| 0 | Done | The last line is the PR URL |
| 1 | Config or CLI error | Read the message; it is one line, not a stack |
| 2 | Escalated — a gate or a review round needs a human | Read `log.txt` and the PR, tell the user what blocked, rerun the same command to resume |
| 3 | Claude usage limit | State is saved; rerun when the window resets |
| 130 | `^C` | Nothing to do |

Rerunning the same command resumes from where it stopped — never delete the
run directory or the worktree to "start clean" unless the user asks. The run's
artifacts are next to the log: `state.json`, the raw transcripts, and the
`work/` copy holding `spec.md`, `plan.md`, `review.md` and `pr.md`.

## sync

Draft PRs wait for humans, and the base moves while they wait.

```bash
fabrika sync --dry-run   # prints the selection, changes nothing
fabrika sync             # --concurrency <n>, default 2
```

Always show the user the dry run first and let them say go: the selection
filters by author, which deliberately includes their hand-written branches.
It touches only conflicted PRs that target the base and are not checked out
anywhere on this machine; everything else is reported with the rule that
skipped it.

## What stays with the human

People write tickets and people merge pull requests. Do not `git push`, do not
`gh pr merge`, do not resolve a review thread, and do not edit a run's
`.fabrika/work/` artifacts by hand. If a run cannot finish, the answer is a
sentence to the user, not a workaround.
