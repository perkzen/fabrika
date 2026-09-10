# Internals

Operator and contributor notes. The [README](../README.md) covers what fabrika
is and how to run it; this file covers how it is built.

## Source layout

| Path | Role |
| --- | --- |
| `src/cli.ts` | `fabrika init` / `fabrika run <ticket>` / `fabrika run --file <spec>`; auth probe; exit codes |
| `src/run.ts` | The loop: naming call, worktree, stages with gate feedback, merge base, draft PR, review rounds; `state.json` for resume |
| `src/claude.ts` | Spawns `claude -p` with fabrika's skills as a `--plugin-dir`, parses `stream-json`, typed errors (`ClaudeAuthError`, `ClaudeRateLimited`, `ClaudeFailed`) |
| `src/config.ts` | `Schema` for `.fabrika/config.json`; the `init` template |
| `src/ticket.ts` | The `Ticket` record and its two sources: a Linear issue (one GraphQL POST) or a spec file (frontmatter + first H1) |
| `src/mcp.ts` | Resolves MCP servers from Claude Code's config scopes into a scoped 0600 temp file |
| `src/worktree.ts` | Worktree under `~/.fabrika/worktrees/<repo>/<ticket>`, `.fabrika/work/` exclude, changed files, commit count, merge, push |
| `src/gate.ts` | Sequential host-run gate; stops at the first failure and returns its output tail |
| `src/cubic.ts` | Reads cubic reviews and threads via `gh`, posts replies, resolves threads under the two conditions |
| `src/checks.ts` | Reads the PR's checks for the pushed commit via `gh`, waits for them to settle, pulls a failed job's log, reruns once for flakes |
| `src/shell.ts` | Subprocess helper with interleaved stdout/stderr and an exit code |
| `prompts/` | Stage prompts and per-stage system prompts, `{{title}}`-style substitution |
| `skills/` | The `fabrika:*` skills each stage prompt names; `.claude-plugin/plugin.json` is the manifest |
| `scripts/smoke.ts` | CLI behaviour checks (see below) |

Built on [Effect](https://effect.website) 4.x (release candidate), whose core
package carries the filesystem, path and CLI modules; subprocesses come from
`effect/unstable/process` and the Node bindings from `@effect/platform-node`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Clean run; the last log line is the PR URL |
| 1 | Configuration or CLI error |
| 2 | Escalated: a human needs to look. The worktree and PR (if any) are left in place; rerun to resume |
| 3 | Claude usage limit hit; state is saved, rerun once the window resets |

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

The ticket body is inlined into the spec prompt for both sources, so the Linear
server is optional even on Linear runs. It only lets the planner read comments
and linked issues. To use it, register a read-only key once, user-scoped:

```bash
claude mcp add -s user --transport http linear-ro https://mcp.linear.app/mcp \
  --header "Authorization: Bearer $LINEAR_API_KEY"
```

A Linear run reads `LINEAR_API_KEY` from `~/.config/fabrika/.env`. Running from
a file needs no Linear key at all.

## Run state

Each run keeps its state and logs outside the target repo, in
`~/.fabrika/runs/<repo>/<ticket>/`:

- `state.json`: session id, completed stages, branch name, PR number, review round
- `log.txt`: the human-readable log
- one raw `stream-json` file per agent call
- `work/`: a copy of the worktree's `.fabrika/work/` made when the run finishes

Rerunning the same command resumes from that state. On escalation the worktree
is left in place for a human.

`.fabrika/work/` is kept out of git through the target repo's
`.git/info/exclude` (shared by its worktrees), so the stage artifacts never
land in a commit but survive the worktree.

## One session, many stages

Every stage resumes the same Claude session, so all stages share one context
window. That keeps the implementer's knowledge available to the reviewer, at
the cost of a long transcript by the end.

## Review loop details

After the draft PR opens, each round:

1. waits for a cubic review of the pushed commit
2. reads open review threads, and the PR's checks for that commit
3. reruns a failed Actions run once, for flakes
4. hands threads and failed-step logs to the agent, which fixes or disputes each one
5. posts the replies, resolves only threads the agent addressed, merges the base branch again, runs the gate, pushes

Done means: the cubic score equals `review.requireScore`, no threads are open,
and no check on the pushed commit is failing. After `review.maxRounds` rounds
the run escalates. Merging (never rebasing) keeps pushed commits in place so
cubic's per-commit reviews stay valid.

## Smoke test

```bash
pnpm smoke
```

Spawns a few short `claude -p` runs and checks that a tool call executes, a
deny rule holds under `--dangerously-skip-permissions`, `--resume` carries
context across directories, `--json-schema` returns structured output, and the
`fabrika:*` skills load on both fresh and resumed sessions. Run it before
trusting anything else.

## Migrating an old config

A `.fabrika/config.json` written by an older `init` has a three-stage list.
Copy the `stages` array from `src/config.ts` to adopt the six-stage pipeline.
