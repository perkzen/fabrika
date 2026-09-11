# fabrika skills

Loaded into every stage with `--plugin-dir <fabrika root>`, so a stage prompt
can say "run the `fabrika:tdd` skill" and it resolves in any target repo. The
target repo's own `.claude/skills/` still load alongside.

| Skill | Stage | Reads | Writes |
| --- | --- | --- | --- |
| `fabrika:configure` | `fabrika init`, before any run | CI workflows, lockfile, scripts | `{base, install, gate}` as structured output; the host writes the config |
| `fabrika:branch-naming` | naming call, before the worktree exists | ticket, repo | `{type, slug, preview}` as structured output; the host builds the branch |
| `fabrika:to-tickets` | human-invoked, before a run | a spec, plan, or conversation | `.fabrika/tickets/<feature>/<NN>-<slug>.md`, each runnable with `fabrika run --file` |
| `fabrika:to-spec` | spec | ticket, repo | `.fabrika/work/spec.md` |
| `fabrika:research` | called by to-spec and grill-with-docs | primary sources | `.fabrika/work/research/<topic>.md` with citations |
| `fabrika:plan` | plan | spec | `.fabrika/work/plan.md` |
| `fabrika:grill-with-docs` | plan (called by `plan`) | plan | plan `## Decisions` |
| `fabrika:implement` | implement | plan, spec | code, one commit per slice; plan amendments |
| `fabrika:tdd` | implement, and every fix | spec seams | code + one commit per cycle |
| `fabrika:codebase-design` | reference for spec, tdd, refactor | — | — |
| `fabrika:code-comments` | reference for implement, tdd, code-review | — | — |
| `fabrika:domain-modeling` | called by spec, grill, refactor | `CONTEXT.md`, `docs/adr/` | glossary entries and ADRs, each its own commit |
| `fabrika:improve-codebase-architecture` | refactor | branch diff | `.fabrika/work/refactor.md`, refactor commits |
| `fabrika:security` | security | branch diff | `.fabrika/work/security.md`, fix commits |
| `fabrika:code-review` | review | spec, repo standards | `.fabrika/work/review.md`, `.fabrika/work/pr.md`, fix commits |
| `fabrika:fix-ci` | review rounds, when a PR check fails | the failed steps' log, workflow files, gate config | `.fabrika/work/ci.md`, `fix(ci):` commits, `## Gate gaps` in `pr.md` |
| `fabrika:resolving-merge-conflicts` | merge (host-triggered when merging the base conflicts) | both sides' history, spec | the merge commit |

`.fabrika/work/` is excluded from git by the host (`.git/info/exclude`), copied
to `~/.fabrika/runs/<repo>/<ticket>/work/` when the run finishes, and `pr.md`
becomes the pull request body.

Every skill is written for an unattended run: wherever the original would ask
the user, the fabrika version decides, records the decision, and moves on.

## Names

Skill names follow the `engineering/` folder of Matt's repo where a counterpart
exists (`to-spec`, `to-tickets`, `tdd`, `implement`, `codebase-design`,
`domain-modeling`, `improve-codebase-architecture`, `code-review`, `research`,
`resolving-merge-conflicts`, `grill-with-docs`), so the two sets read the same.
`plan`, `security`, `branch-naming`, `configure`, `fix-ci`, and `code-comments` are fabrika's own.

To use the human-facing ones (`to-tickets`) in an interactive session, load the
plugin: `claude --plugin-dir /path/to/fabrika`.

## Attribution

`tdd`, `implement`, `codebase-design`, `domain-modeling`, `code-review`,
`research`, `resolving-merge-conflicts`, `to-spec`, `to-tickets`,
`improve-codebase-architecture`, and `grill-with-docs` (from `grilling` +
`grill-with-docs`)
are adapted from Matt Pocock's skills, <https://github.com/mattpocock/skills>,
MIT License, Copyright (c) Matt Pocock. The adaptations remove the interactive
checkpoints and route output to `.fabrika/work/`.
