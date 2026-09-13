# fabrika skills

Loaded into every stage with `--plugin-dir <fabrika root>`, so a stage prompt
can say "run the `fabrika:tdd` skill" and it resolves in any target repo. The
target repo's own `.claude/skills/` still load alongside.

| Skill | Stage | Reads | Writes |
| --- | --- | --- | --- |
| `fabrika:fabrika` | human-invoked, outside a run | `.fabrika/config.json`, a run's log | `.fabrika/config.json` through `fabrika init`, nothing otherwise — it drives the CLI for a human in an interactive session |
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

Every skill but `fabrika:fabrika` is written for an unattended run: wherever
the original would ask the user, the fabrika version decides, records the
decision, and moves on. `fabrika:fabrika` is the exception by construction —
it is the operator's side of the tool, user-invocable only
(`disable-model-invocation: true`), so no stage can invoke it — `--plugin-dir`
still loads it, the flag keeps it off the model's list.

## Names

Skill names follow the `engineering/` folder of Matt's repo where a counterpart
exists (`to-spec`, `to-tickets`, `tdd`, `implement`, `codebase-design`,
`domain-modeling`, `improve-codebase-architecture`, `code-review`, `research`,
`resolving-merge-conflicts`, `grill-with-docs`), so the two sets read the same.
`plan`, `security`, `branch-naming`, `configure`, `fix-ci`, `code-comments` and
`fabrika` are fabrika's own.

To use the human-facing ones (`fabrika`, `to-tickets`) in an interactive
session, install them from the skills registry:

```bash
npx skills add perkzen/fabrika@fabrika -g
```

`-g` installs for the user; drop it to install into the current project.
`npx skills add perkzen/fabrika -l` lists every skill in this table, and
`--skill <a,b>` picks which to install. Loading the whole plugin still works
and gets all of them: `claude --plugin-dir /path/to/fabrika`.

## Attribution

`tdd`, `implement`, `codebase-design`, `domain-modeling`, `code-review`,
`research`, `resolving-merge-conflicts`, `to-spec`, `to-tickets`,
`improve-codebase-architecture`, and `grill-with-docs` (from `grilling` +
`grill-with-docs`)
are adapted from Matt Pocock's skills, <https://github.com/mattpocock/skills>,
MIT License, Copyright (c) Matt Pocock. The adaptations remove the interactive
checkpoints and route output to `.fabrika/work/`.
