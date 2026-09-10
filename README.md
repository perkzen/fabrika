# fabrika

A local software factory: a ticket goes in, a reviewed draft PR comes out.

```
ticket (Linear issue or local spec file) → plan → implement (TDD) → host-run gate → draft PR → review loop until clean → human merges
```

Every stage is a separate headless run of the **real `claude` binary** on your
existing Claude Code subscription login. No API keys, no containers, no custom
auth. The runner spawns the CLI and never touches its credentials.

## Status

`fabrika init` and `fabrika run` work end to end up to the draft PR, proven on
a scratch repo: worktree, plan → implement on one resumed session, host-run
gate with feedback iterations, and resume from `state.json`. The cubic review
loop is written to PLAN.md §Cubic but has not yet been exercised against a real
PR.

## How it is meant to work

- **Verification is host-run and deterministic** — the gate is a list of
  commands from your repo's own config (`compile`, `test`, `lint`, …). A green
  gate is the only definition of done. The agent's self-report is never trusted.
- **Definition of done includes external review.** After the draft PR opens,
  the loop reads review-bot threads, fixes or disputes each one with a posted
  reply, and repeats until the bot's score is clean *and* no threads are open.
  It never resolves a thread it did not address.
- **Humans own both ends.** Tickets are created by people; PRs are merged by
  people. No auto-merge, no writes to the ticket tracker.
- **Linear is one input, not the input.** A ticket is a small record: an
  identifier, a title, a description, an optional URL. It can come from a Linear
  issue or from a local markdown spec file; the loop cannot tell the difference.
- **Stages are data.** Adding a role is one entry in the config, not code.
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

The source is an explicit flag, never guessed from the argument. A spec file is
markdown with optional frontmatter:

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
a file ticket gets `preview/domen/fix/login-timeout/<slug>` and a Linear ticket
gets `preview/domen/feat/PAR-123/<slug>`. Running from a file needs no Linear
key at all.

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
context across directories, and `--json-schema` returns structured output.

## Layout

| Path | Role |
| --- | --- |
| `src/claude.ts` | Spawns `claude -p`, parses `stream-json`, typed errors (`ClaudeAuthError`, `ClaudeRateLimited`, `ClaudeFailed`), credential fallback |
| `src/config.ts` | `Schema` for `.fabrika/config.json`; the `init` template |
| `src/ticket.ts` | The `Ticket` record and its two sources: a Linear issue (one GraphQL POST) or a spec file (frontmatter + first H1); slug and branch name |
| `src/mcp.ts` | Resolves MCP servers from Claude Code's config scopes into a scoped 0600 temp file |
| `src/worktree.ts` | Worktree under `~/.fabrika/worktrees/<repo>/<ticket>`, changed files, commit count, push |
| `src/gate.ts` | Sequential host-run gate; stops at the first failure and returns its output tail |
| `src/run.ts` | The loop: stages with gate feedback, draft PR, cubic rounds; `state.json` for resume |
| `src/cubic.ts` | Reads cubic reviews and threads via `gh`, posts replies, resolves under the two conditions |
| `src/shell.ts` | Subprocess helper with interleaved stdout/stderr and an exit code |
| `src/cli.ts` | `fabrika init` / `fabrika run <ticket>` / `fabrika run --file <spec>` |
| `prompts/` | Stage prompts and per-stage system prompts, `{{title}}`-style substitution |
| `scripts/smoke.ts` | The behaviour checks above |

Built on [Effect](https://effect.website) 4.x (release candidate), whose core
package now carries the filesystem, path and CLI modules; subprocesses come
from `effect/unstable/process` and the Node bindings from
`@effect/platform-node`.

## Deliberately not doing

Containers. Custom auth or OAuth handling. Parallel multi-agent fan-out.
Auto-merge. Ticket-tracker writes.
