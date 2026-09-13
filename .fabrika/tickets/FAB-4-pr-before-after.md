---
id: FAB-4
type: feat
---

# A PR that changes what a user sees should show before and after

## Problem

FAB-1 changed nothing but output. Its pull request describes that change in
prose and shows none of it:

> the console holds a two-line **live region** under permanent scrollback —
> run progress, plus gate progress or an animated open **wait** — colours each
> kind of line, walks agent markdown into real headings and lists capped at
> 20, and gives each tool call one short line

That is an accurate paragraph and it is not evidence. A reviewer has two ways
to find out whether the new output is better than the old: trust the sentence,
or check out the branch, install, and run a ticket through it. The diff is no
help — a diff of `src/infra/console.ts` shows which strings moved, not what a
run now looks like.

The body comes from one place. `fabrika:code-review` §5
(`skills/code-review/SKILL.md:60`) fixes its five sections — Summary,
Assumptions to check, Refactors, Security, Testing — and
`src/pipeline/steps/pull-request.ts:41` posts the file verbatim. None of those
five is a place to put what the thing looks like now, so nobody put it
anywhere.

fabrika is aimed at whatever repo it is run in. The change that needs showing
is a terminal frame here, a simulator screen on an iOS repo, a page on a web
app, a window on a desktop app. Prose is the worst available medium for all
four.

## Solution

When the branch touches the code that decides what a user sees, the PR body
carries a **Before / After** section: two screenshots, side by side, of the
same thing on the base and on the branch.

Screenshots, not transcripts. A screenshot is the one artifact that means the
same thing on an iOS Simulator, a browser, a desktop window and a terminal,
and it is the only one that shows the half of a change that text throws away —
colour, layout, spacing, the live region, what the screen looks like at rest.
FAB-1 is the proof: its piped output is byte-identical by design, pinned as a
table in `test/run-event.test.ts`, so a text capture of that change would have
shown *no difference at all*.

The captures are produced by the host running a command from committed config
— not written from memory by the agent that just did the work.

## How it stays repo-agnostic

fabrika does not learn what a Simulator is. It reuses the seam the gate
already has: a command from committed config, run by the host in the
worktree. `sh(cwd, script, env)` (`src/infra/shell.ts`) already takes an
environment, so the contract is small.

**The contract.** fabrika sets `FABRIKA_CAPTURE_DIR` to an empty directory and
runs the command in the worktree. The command writes image files there and
exits 0. A non-zero exit, a timeout, or an empty directory means no section —
never a failed run. fabrika reads the directory, pairs the files by name
across the two revisions, and embeds them; it never looks inside one.

**The platform knowledge stays in the target repo, which is where it already
lives.** One line each, to prove the shape rather than to own it:

| Repo | What its capture script already has |
| --- | --- |
| iOS | `xcrun simctl io booted screenshot` after its own build-and-launch |
| Web | its e2e runner's screenshot call against its own dev server or preview URL |
| Desktop | the window capture its own UI tests use |
| Terminal | its output run under a pty and rendered to PNG (`freeze`-class tool) |

For fabrika's own repo that script replays a fixture of run events through the
console presenter — what `test/console.test.ts` already does — and never runs a
ticket. A capture that costs an agent bill twice per PR is a capture nobody
turns on.

A repo that cannot produce an image for its change writes a `.txt` instead and
gets a fenced block — scrubbed and capped, the floor rather than the goal.
A repo that has a live URL worth linking writes it to a `.url` file and gets a
link. Three file kinds, one contract, no platform branches in fabrika.

**`fabrika init` proposes a capture only where it can see one** — an existing
screenshot helper, a UI test, a CLI entry point — and none otherwise, and says
which in its notes, the way it derives the gate from CI.

**The host machine is the toolchain.** An iOS capture needs a Mac with a
simulator; a desktop capture needs a display. That is already fabrika's model
— the host machine does the verifying — so it is a constraint to state, not a
problem to solve. A capture that cannot run on the host produces no section.

## Behaviour wanted

**A capture is the host's, not the agent's.** The review stage writes `pr.md`
after six stages of work; asked for a "before" it can only produce a
recollection. Running a command against the base is a host job, and the host
is where the determinism is.

**Configured, not inferred.** `pr.capture` in `.fabrika/config.json`, beside
`draft` and `emptyCommit`, shaped like the gate: `{ name, run, when }`, a
list, because a repo has more than one screen worth showing.

**Gated by the diff, with the gate's matcher.** `GateStep.when`
(`src/adapters/shell-gate.ts:41`, `node:path` `matchesGlob` against
`workspace.changedFiles`) is the mechanism as it stands today; if FAB-3 has
landed and moved it somewhere shared, use that instead. Either way, do not
invent a second trigger — this ticket does not depend on FAB-3 and must not
wait for it. For this repo the globs are
`src/infra/console.ts`, `src/infra/markdown.ts`, `src/run-event.ts` — where
`plain()` decides every piped line — and `src/cli.ts`.

**Side by side.** Two images in one markdown table row, captioned with the
capture's name, so a reviewer sees the difference without scrolling between
them. A capture that is new on the branch shows an empty before and says so.

**Silence when it does not apply.** No configured capture, a diff that matches
no glob, or a capture that produced nothing: today's body exactly, no section,
no empty heading, no "n/a".

**One writer for the body.** `pr.md` remains what gets posted. The spec says
whether the host appends the section before opening the PR or hands the
captured images to the review stage to place — but not both, and not a second
body assembled somewhere else.

## The part most likely to be got wrong

**1. An image in a PR body needs a URL, and fabrika has nowhere to put one.**
This is the whole ticket's risk and it is not a detail. `Forge.open` takes
`body: string` (`src/ports/forge.ts`), `gh pr create --body` posts markdown,
and GitHub's drag-and-drop attachment endpoint is a browser session that `gh`
does not expose. The candidates, none of them free:

- **A dedicated branch** (`fabrika-captures/<ticket>` or an orphan branch)
  pushed to the same remote, linked as `raw.githubusercontent.com` URLs. Keeps
  the images out of the PR's diff and out of the merged tree.
- **A release asset** via `gh release upload`.
- **Committing the images on the branch** under a known directory. Always
  renders, and puts binaries in the repo's history forever.

**The spec verifies rendering on a private repository before it chooses.**
Most target repos are private, and a URL that renders for the person who
pushed it and shows a broken image to everyone else is the failure that would
ship here unnoticed. If none of the candidates survives that test, the honest
fallback is a link to the images rather than a body that looks broken — say so
in the spec rather than discovering it on the first real PR.

**2. There is no "before" left by the time anyone wants one**, and the two
moments that could produce one are not equivalent. The review stage runs last,
in a worktree six stages of commits past the base, so the spec picks between:

- **Eager**, at the end of the `workspace` step — `workspace.create` has just
  put the tree on the new branch off a freshly fetched base and nothing has
  committed (`src/pipeline/steps/workspace.ts`). Cheap to reach, and it
  **cannot use the glob gate**: `changedFiles` is empty at that point, which is
  the same trap FAB-3 names for `spec` and `plan`. Every run pays on a cache
  miss, including the ones that touch no UI.
- **Lazy**, at the `pull-request` step — the gate applies, a cache hit is free,
  and a miss costs a checkout of the base sha plus an install.

The fact that discriminates: `pull-request.ts` calls `syncWithBase()` before
pushing, so by PR time the branch already contains the *current* base. A
"before" captured at run start is from a base that may since have moved; a
lazy one is from the base the PR's own diff is computed against. The spec
should have a strong reason if it does not go lazy.

Either way, **a resume must not re-derive it**. The `workspace` step is not
`once` (`src/pipeline/step.ts:48`), so it runs again — and `create` reuses a
tree already on the branch. A capture taken at that moment on the second pass
is the *after*, labelled "before", which is worse than no section at all. Under
lazy, the cache below *is* the before, and this stops being a special case.

**3. The "before" is the expensive half, and it is cacheable.** A terminal
capture is a second of CPU; an iOS capture is a full build and a simulator
boot, paid on a tree that is identical for every ticket cut from the same
base. Cache base captures by `(base sha, capture name)` under
`~/.fabrika/captures/<repo>/`, beside the run directories that already live
there. The base moves rarely; the expensive build then happens once per base
commit instead of once per run, and a resume reads the same cache rather than
recapturing. The glob gate stays the first defence.

**4. Nothing in the body may point at a path a reader cannot open.**
`c32be1e` settled this for a code comment and it holds harder for a PR body:
`.fabrika/work/` is never committed and `~/.fabrika/` is one machine's disk.
The same applies to the `.txt` fallback: it is scrubbed — `94a532d` fixed an
ANSI escape injection on the console, and captured bytes are no more trusted
here — fenced, and capped the way the console caps a message at
`MESSAGE_LINES`, because a GitHub body dies at 65536 characters.

## Constraints

- **`pr.md` stays the body**, posted verbatim by
  `src/pipeline/steps/pull-request.ts:41`, and its fallback to the ticket
  description when no stage wrote one keeps working.
- **A capture never fails a run.** No image, a non-zero exit, a timeout, a
  missing simulator: the section is absent and the run continues. The PR is
  the point; the screenshots are evidence attached to it.
- **The capture command is committed config**, never one the agent composes —
  the same rule that keeps a gate step from laundering the deny list back in
  (`src/adapters/shell-gate.ts`).
- **Every capture is bounded**: a timeout on the command and a cap on the
  bytes it may produce. An unbounded capture stalls every run on the repo.
- **A config without `pr.capture` loads and behaves exactly as today.**
- **A run whose diff matches no glob pays nothing** — no extra checkout, no
  extra install, no extra command.
- **Exit codes and the piped contract hold.** The PR URL is still the last
  stdout line of a clean run.
- **Tested through `test/harness.ts`**: in-memory workspace, no git, no shell.
  A diff that matches gets the section; one that does not gets today's body and
  runs no command; a failing capture leaves the body unchanged; a resumed run
  reuses the cached "before" rather than capturing a second one.

## Out of scope

- **Owning any platform's capture mechanics.** No simulator driver, no
  headless browser, no screenshot library in this repo's dependencies. If
  fabrika ever needs to know which platform it is looking at, the contract
  above was the wrong one.
- Diffing images, flagging visual regressions, or asserting anything about
  what the screenshots contain.
- Recording a whole run as a video, cast or gif.
- Making before/after a gate step, or anything else that can fail a run.
- Changing what the review stage reviews, or any stage prompt beyond the
  `pr.md` template section this adds.
- Reformatting the other five sections of `pr.md`.

## Done when

- A branch that touches a capture's globs opens a PR whose body shows that
  capture's before and after side by side, rendering for anyone who can see
  the repo.
- The same works on a repo whose capture command is an iOS screenshot, a
  browser screenshot, a window capture or a rendered terminal frame, with no
  fabrika change between them.
- A capture that cannot run — no simulator, no display, non-zero exit, timeout
  — leaves the body as it is today and the run finishes clean.
- A branch that touches no capture's globs runs no capture command.
- A resumed run shows the same "before" as the run it resumed, without
  recapturing it.
- `fabrika init` writes a `capture` where one fits and none where it does not,
  and says which it chose.
- `pnpm compile`, `pnpm build` and `pnpm test` are green.
