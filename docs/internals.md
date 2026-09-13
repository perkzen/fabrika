# Internals

Operator and contributor notes. The [README](../README.md) covers what fabrika
is and how to run it; this file covers how it is built.

## Source layout

A run is a pipeline of steps over a set of ports. Each port is an interface
with one adapter in production and an in-memory one in the tests; nothing in
`pipeline/` knows which is behind it.

| Path | Role |
| --- | --- |
| `src/cli.ts` | `fabrika init` / `fabrika run <ticket>` / `fabrika run --file <spec>`; auth probe; exit codes |
| `src/run.ts` | The composition root: which adapter is behind each port, then run the pipeline |
| `src/pipeline/step.ts` | The `Step` type, the builder that orders steps, and the driver that runs them and resumes |
| `src/pipeline/fabrika.ts` | The run fabrika ships: preflight, branch, workspace, the configured stages, PR, review |
| `src/pipeline/steps/` | One file per step; `sync.ts` is the base-merge both the PR and the review loop use |
| `src/ports/` | `Agent`, `Workspace`, `Gate`, `Forge`, `Reviewer`, `TicketSource`, `Prompts`, `RunStore`, `Journal`, `RunContext` |
| `src/adapters/` | Claude, git worktree, shell gate, `gh`, cubic, Linear, a spec file, the run directory |
| `src/config.ts` | `Schema` for `.fabrika/config.json`; the `init` template, neutral where the values are repo-specific |
| `src/configure.ts` | The `init` call: schema, the validator that rejects an unusable answer, and the guard that keeps `git push` out of a gate step |
| `src/ticket.ts` | The `Ticket` record, the slug rules and the branch pattern |
| `src/run-event.ts` | The `RunEvent` union and `plain()`, its ANSI-free rendering — what `log.txt` gets, and what a console gets for every kind but agent speech |
| `src/infra/console.ts` | The presenter: the interactivity verdict, the live region, the colour table, the height cap and the frame timer |
| `src/infra/markdown.ts` | `marked`'s lexer walked into styled lines, the same walk in both terminal modes |
| `src/infra/transcript.ts` | An assistant message's content blocks into run events, and what one tool call is about |
| `src/infra/` | The subprocess helper, the Claude CLI wrapper and MCP resolution — implementation details of the adapters |
| `src/paths.ts` | The one place that resolves the package root, so the lookup works from `src/` and from `dist/` |
| `prompts/` | Stage prompts and per-stage system prompts, `{{title}}`-style substitution |
| `skills/` | The `fabrika:*` skills each stage prompt names; `.claude-plugin/plugin.json` is the manifest |
| `test/harness.ts` | Every port in memory, so a step can be exercised with no repository, no GitHub and no agent |
| `scripts/smoke.ts` | CLI behaviour checks against the real `claude` (see below) |

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

## Configuring a repo

`fabrika init` writes the template in `src/config.ts`, but `base`, `install`
and `gate` are left neutral there and filled in by one structured call that
applies the `fabrika:configure` skill. They are the fields that cannot be
shipped: a gate step naming a script the target repo does not have goes red on
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

- `state.json`: session ids by key, completed stages, branch name, ticket type, PR number, review round
- `log.txt`: the human-readable log
- one raw `stream-json` file per agent call
- `work/`: a copy of the worktree's `.fabrika/work/` made when the run finishes

Rerunning the same command resumes from that state. On escalation the worktree
is left in place for a human.

`.fabrika/work/` is kept out of git through the target repo's
`.git/info/exclude` (shared by its worktrees), so the stage artifacts never
land in a commit but survive the worktree.

## Skipping a stage

A stage with `only` runs for those ticket types and is skipped for the rest —
the type being the naming call's verdict, not the Linear label, recorded in
`state.json` so a resumed run skips identically. The shipped config puts
`only: ["feat"]` on `refactor`: a fix or a chore rarely has architecture worth
reshaping, and with one session per stage the pass costs a cold start plus a
full gate run. `security` deliberately has no `only` — a small diff is a small
security review.

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
| `round-<round>` | one review round: cubic threads, CI fixes, the repair pass |

A stage that assumes it remembers an earlier one is a bug in its prompt — the
inputs have to be named as paths.

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

## Tests

```bash
pnpm test
```

`node --test` over `test/*.test.ts`, no test dependency. The tests run the
real steps against `test/harness.ts` — every port in memory — so they cover
the gate-retry loop, the review loop's done condition, the rule that a thread
is resolved only when a commit touched its file, and the one-rerun-per-flake
behaviour, in milliseconds and with no network.

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
Run `fabrika init` in an empty directory and copy the `stages` array out of the
file it writes — `src/config.ts` holds the same template as a TypeScript object
now, which is not valid JSON. That is also where `only` shows up, if the
upgrade is what brings you here.
