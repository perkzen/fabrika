# fabrika

A local software factory: a ticket goes in, a reviewed draft PR comes out.

```
Linear ticket → plan → implement (TDD) → host-run gate → draft PR → review loop until clean → human merges
```

Every stage is a separate headless run of the **real `claude` binary** on your
existing Claude Code subscription login. No API keys, no containers, no custom
auth. The runner spawns the CLI and never touches its credentials.

## Status

Scaffold. `fabrika init` works; the ticket loop (`fabrika run`) is not wired
yet.

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
- **Stages are data.** Adding a role is one entry in the config, not code.
- **Invariants are mechanism, not prose.** `git push`, `gh pr merge` and thread
  resolution are denied to the agent via `--disallowedTools`; the host does them.

## Quick start

```bash
npm install
cd /path/to/your/repo
npx tsx /path/to/fabrika/src/cli.ts init     # writes .fabrika/config.json
```

Edit `.fabrika/config.json`: base branch, branch-name pattern, gate commands,
and which MCP servers each stage may use. The file is meant to be committed to
the target repo — the gate for a repo belongs in that repo.

MCP servers come from Claude Code's own config (`claude mcp add …`); a stage
names the ones it wants. Remote servers must carry a static
`Authorization` header — OAuth-backed servers cannot re-authenticate
unattended. For Linear, register a read-only key once, user-scoped:

```bash
claude mcp add -s user --transport http linear-ro https://mcp.linear.app/mcp \
  --header "Authorization: Bearer $LINEAR_API_KEY"
```

Before trusting anything, prove the CLI behaviours the loop depends on:

```bash
npm run smoke
```

It spawns a few short `claude -p` runs and checks that a tool call executes,
a deny rule holds under `--dangerously-skip-permissions`, `--resume` carries
context across directories, and `--json-schema` returns structured output.

## Layout

| Path | Role |
| --- | --- |
| `src/claude.ts` | Spawns `claude -p`, parses `stream-json`, typed errors (`ClaudeAuthError`, `ClaudeRateLimited`, `ClaudeFailed`), credential fallback |
| `src/config.ts` | `Schema` for `.fabrika/config.json`; the `init` template |
| `src/mcp.ts` | Resolves MCP servers from Claude Code's config scopes into a scoped 0600 temp file |
| `src/cli.ts` | `fabrika init` / `fabrika run <ticket>` |
| `scripts/smoke.ts` | The behaviour checks above |

Built on [Effect](https://effect.website) 3.x with `@effect/platform` for the
subprocess and filesystem.

## Deliberately not doing

Containers. Custom auth or OAuth handling. Parallel multi-agent fan-out.
Auto-merge. Ticket-tracker writes.
