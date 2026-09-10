# fabrika

A local software factory: a ticket goes in, a reviewed draft PR comes out.

```
ticket (Linear issue or local spec file)
  → spec → plan (grilled) → implement (TDD) → architecture → security → code review
  → host-run gate after every code stage → merge base (conflicts → agent) → draft PR
  → review loop until cubic 5/5, no open threads, and PR checks green — re-merging base each round
  → human reviews the PR
```

Every stage is a separate headless run of the **real `claude` binary** on your
existing Claude Code subscription login. No API keys, no containers, no custom
auth. The runner spawns the CLI and never touches its credentials.

## Status

`fabrika init` and `fabrika run` work end to end up to the draft PR, proven on
a scratch repo: worktree, stages on one resumed session, host-run gate with
feedback iterations, and resume from `state.json`. The six-stage pipeline and
its skills are new and have not yet run on a real ticket; the cubic review
loop has not yet been exercised against a real PR.

## How it is meant to work

- **Verification is host-run and deterministic** — the gate is a list of
  commands from your repo's own config (`compile`, `test`, `lint`, …). A green
  gate is the only definition of done. The agent's self-report is never trusted.
- **Definition of done includes external review and CI.** After the draft PR
  opens, the loop reads review-bot threads, fixes or disputes each one with a
  posted reply, reads the PR's checks, fixes what failed from the failed
  steps' log, and repeats until the bot's score is clean, no threads are open,
  *and* no check on the pushed commit is failing. A failed Actions run is rerun
  once first, for flakes. The host does the watching; the agent only fixes.
  It never resolves a thread it did not address.
- **Humans own both ends.** Tickets are created by people; PRs are merged by
  people. No auto-merge, no writes to the ticket tracker.
- **Linear is one input, not the input.** A ticket is a small record: an
  identifier, a title, a description, an optional URL. It can come from a Linear
  issue or from a local markdown spec file; the loop cannot tell the difference.
- **Stages are data.** Adding a role is one entry in the config, not code.
- **Method lives in skills, not prompts.** Each stage prompt is a few lines
  naming a `fabrika:<skill>`; the skill carries the method (see below). The
  same skills work in any target repo because fabrika ships them itself.
- **Unattended means recorded.** Nowhere in the pipeline can an agent ask a
  question. Every place an interactive skill would ask, the fabrika version
  decides and writes the decision down, so the human reviews a list of
  assumptions, not a mystery.
- **Small commits.** One commit per red→green cycle, one per finding fixed.
  The host commits leftovers after a stage as a safety net, never as the plan.
- **Invariants are mechanism, not prose.** `git push`, `gh pr merge` and thread
  resolution are denied to the agent via `--disallowedTools`; the host does them.

## Quick start

```bash
pnpm install
cd /path/to/your/repo
/path/to/fabrika/node_modules/.bin/tsx /path/to/fabrika/src/cli.ts init   # writes .fabrika/config.json
```

fabrika reads the *current* directory as the target repo, so it is invoked by
absolute path rather than through `pnpm exec` — `pnpm --dir` would move the
working directory to fabrika's own checkout.

Edit `.fabrika/config.json`: base branch, branch-name pattern, gate commands,
and which MCP servers each stage may use. The file is meant to be committed to
the target repo — the gate for a repo belongs in that repo.

Then run a ticket from either source:

```bash
/path/to/fabrika/node_modules/.bin/tsx /path/to/fabrika/src/cli.ts run PAR-123        # a Linear issue
/path/to/fabrika/node_modules/.bin/tsx /path/to/fabrika/src/cli.ts run --file spec.md # a local spec
```

The source is an explicit flag, never guessed from the argument. The
`fabrika:to-tickets` skill writes such files from a spec or conversation, under
`.fabrika/tickets/<feature>/`, so a feature can be split into runnable tickets
without touching the team's Linear. A spec file is markdown with optional
frontmatter:

```markdown
---
id: login-timeout   # optional; default: the filename stem
type: fix           # optional; feat | fix | chore, default feat
linear: PAR-412     # optional; becomes the identifier and links the branch
---
# Login times out on slow networks

<the spec>
```

The branch pattern fills `{type}`, `{ticket}` and `{slug}` from that record, so
a file ticket gets `domen/fix/login-timeout/<slug>` and a Linear ticket
`domen/feat/PAR-123/<slug>`. The type and slug come from one short structured
call at the start of the run that applies the `fabrika:branch-naming` skill
(terse slug, type from labels or wording); it also decides whether the change
has a browser-visible surface, in which case `previewPrefix` (`preview/`, the
prefix Vercel's Ignored Build Step lets through) goes in front. An answer that
breaks the naming rules is replaced by the deterministic parts, and the chosen
name is saved in `state.json` so a resume lands on the same branch. Running
from a file needs no Linear key at all.

MCP servers come from Claude Code's own config (`claude mcp add …`); a stage
names the ones it wants. Remote servers must carry a static
`Authorization` header — OAuth-backed servers cannot re-authenticate
unattended. The ticket body is inlined into the plan prompt for both sources,
so the Linear server is optional even on Linear runs — it only lets the planner
read comments and linked issues. To use it, register a read-only key once,
user-scoped:

```bash
claude mcp add -s user --transport http linear-ro https://mcp.linear.app/mcp \
  --header "Authorization: Bearer $LINEAR_API_KEY"
```

Each run keeps its state and logs outside the target repo, in
`~/.fabrika/runs/<repo>/<ticket>/`: `state.json` (session id, completed stages,
PR number, review round), `log.txt`, and one raw `stream-json` file per agent
call. Rerunning the same command resumes from that state; on escalation the
worktree is left in place for a human. A Linear run reads `LINEAR_API_KEY` from
`~/.config/fabrika/.env`.

Before trusting anything, prove the CLI behaviours the loop depends on:

```bash
pnpm smoke
```

It spawns a few short `claude -p` runs and checks that a tool call executes,
a deny rule holds under `--dangerously-skip-permissions`, `--resume` carries
context across directories, `--json-schema` returns structured output, and
the `fabrika:*` skills load on both fresh and resumed sessions.

## Stages and skills

| Stage | Skill | Produces |
| --- | --- | --- |
| (before the worktree) | `fabrika:branch-naming` | the branch name: type, slug, and whether `previewPrefix` applies |
| spec | `fabrika:to-spec` | `.fabrika/work/spec.md` — problem, solution, user stories, seams, testing decisions, **assumptions** |
| plan | `fabrika:plan` → `fabrika:grill-with-docs` | `.fabrika/work/plan.md` — ordered vertical slices (test + code), risks, **decisions** from a self-grill |
| implement | `fabrika:implement` → `fabrika:tdd` (+ `fabrika:codebase-design`) | code, one commit per red→green cycle; the plan amended where reality differed |
| (called by spec and grill) | `fabrika:research` | `.fabrika/work/research/<topic>.md` — primary-source answers with citations |
| (side effect of spec, plan, architecture) | `fabrika:domain-modeling` | `CONTEXT.md` entries for resolved terms; an ADR when a decision is hard to reverse, surprising, and a real trade-off |
| architecture | `fabrika:improve-codebase-architecture` | `.fabrika/work/architecture.md`; Strong candidates implemented, Worth-exploring ones explored, all recorded with a status. Scoped to the code the branch touched. |
| security | `fabrika:security` | `.fabrika/work/security.md`; High/Medium fixed, each its own commit |
| review | `fabrika:code-review` | `.fabrika/work/review.md` (Standards + Spec axes, then fixes) and `.fabrika/work/pr.md`, which becomes the PR body |
| cubic rounds | `fabrika:tdd` for fixes | replies and commits per thread (host posts, pushes, resolves) |
| failing PR checks (same rounds) | `fabrika:fix-ci` | `.fabrika/work/ci.md`; one `fix(ci):` commit per cause; a `## Gate gaps` section in `pr.md` when CI caught what the local gate cannot |
| merge (when the base moved and `git merge` conflicts) | `fabrika:resolving-merge-conflicts` | the merge commit; the gate runs after every merge |

The skills are adapted from [Matt Pocock's skills](https://github.com/mattpocock/skills)
(MIT) — see `skills/README.md` — with the interactive checkpoints replaced by
recorded decisions. They are loaded with `--plugin-dir` on every call, so a
target repo needs nothing installed; its own `.claude/skills/` load alongside.

`.fabrika/work/` is kept out of git through the target repo's
`.git/info/exclude` (shared by its worktrees), and copied to
`~/.fabrika/runs/<repo>/<ticket>/work/` when a run finishes, so the artifacts
survive the worktree. The last log line of a clean run is the PR URL.

Trade-off to know about: every stage resumes the same session, so six stages
share one context window. That keeps the implementer's knowledge available to
the reviewer, at the cost of a long transcript by the end.

An existing `.fabrika/config.json` written by an older `init` still has the
three-stage list; copy the `stages` array from `src/config.ts` to adopt the
new pipeline.

## Layout

| Path | Role |
| --- | --- |
| `src/claude.ts` | Spawns `claude -p` with fabrika's skills as a `--plugin-dir`, parses `stream-json`, typed errors (`ClaudeAuthError`, `ClaudeRateLimited`, `ClaudeFailed`), credential fallback |
| `src/config.ts` | `Schema` for `.fabrika/config.json`; the `init` template |
| `src/ticket.ts` | The `Ticket` record and its two sources: a Linear issue (one GraphQL POST) or a spec file (frontmatter + first H1); slug and branch name |
| `src/mcp.ts` | Resolves MCP servers from Claude Code's config scopes into a scoped 0600 temp file |
| `src/worktree.ts` | Worktree under `~/.fabrika/worktrees/<repo>/<ticket>`, `.fabrika/work/` exclude, changed files, commit count, merge, push |
| `src/gate.ts` | Sequential host-run gate; stops at the first failure and returns its output tail |
| `src/run.ts` | The loop: stages with gate feedback, draft PR, cubic rounds; `state.json` for resume |
| `src/cubic.ts` | Reads cubic reviews and threads via `gh`, posts replies, resolves under the two conditions |
| `src/checks.ts` | Reads the PR's checks for the pushed commit via `gh`, waits for them to settle, pulls a failed job's log, reruns once for flakes |
| `src/shell.ts` | Subprocess helper with interleaved stdout/stderr and an exit code |
| `src/cli.ts` | `fabrika init` / `fabrika run <ticket>` / `fabrika run --file <spec>` |
| `prompts/` | Stage prompts and per-stage system prompts, `{{title}}`-style substitution |
| `skills/` | The `fabrika:*` skills each stage prompt names; `.claude-plugin/plugin.json` is the manifest |
| `scripts/smoke.ts` | The behaviour checks above |

Built on [Effect](https://effect.website) 4.x (release candidate), whose core
package now carries the filesystem, path and CLI modules; subprocesses come
from `effect/unstable/process` and the Node bindings from
`@effect/platform-node`.

## Deliberately not doing

Containers. Custom auth or OAuth handling. Parallel multi-agent fan-out.
Auto-merge. Ticket-tracker writes.
