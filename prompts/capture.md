Decide this run's Before / After for ticket {{identifier}} — {{title}}.

The branch is `{{branch}}`, cut from `{{base}}`. Its diff is in front of you:

```bash
git diff --stat {{base}}...HEAD
```

## What you are deciding

A **capture** is one command the host runs twice — once in a detached checkout
of `{{base}}`, once in this worktree — with `$FABRIKA_CAPTURE_DIR` pointing at
an empty directory it must write into. The two halves go on the pull request
side by side, for the part of a change a diff cannot show.

Answer two things: whether this branch changed a surface a person looks at,
and if so the single command that renders it.

## Say no, and mean it

`capture: false` is the ordinary answer. Say it for a branch that changed only
logic, tests, types, docs, config, CI or build wiring, and for a repository
with no user-visible surface at all. A capture of a surface this branch did not
touch produces two identical halves, which is noise on the pull request and a
reviewer's trust spent for nothing.

Do not reason from the file paths alone. A change under a rendering module that
only renames a symbol changes no surface; a change elsewhere that alters what
that module prints does.

## The command

**Only something the repository can already do.** Not a plan to add one. Look
for a script that shoots a page, a window or a simulator; a UI or snapshot test
that already writes an image; a CLI entry point you can hand a fixture and make
print a frame; a static site build a headless browser on `PATH` could shoot.

Then, before you answer:

- **Run it here**, with `FABRIKA_CAPTURE_DIR` set to a scratch directory, and
  look at what it wrote. A command you did not run is a guess.
- **It must work at `{{base}}` too.** The other half runs in a checkout that
  does not have your change — a command that imports a file this branch adds
  renders one half and nothing to compare it against.
- **It must be quiet and fixed.** The two halves differ only by the change, so
  anything that moves on its own — a clock, a random seed, a network fetch, a
  progress bar, an absolute path — is a diff that is all noise. Pin it or pick
  something else.
- Only `.png` `.jpg` `.jpeg` `.gif` `.webp` (shown side by side), `.txt`
  (fenced, capped) and `.url` (an `https://` link) are read. An image is the
  goal; a `.txt` is the floor and still beats prose.
- Give it `timeoutMinutes` if it is slow — a build, a simulator boot. Omitted
  means 2.

Never `git push`, `gh pr merge`, `gh pr review`, a publish or a deploy. The
host owns those and the answer is rejected outright if one appears.

If the command you found does not run cleanly, or wrote nothing, answer
`capture: false` and say so in `reason`. A capture may never fail a run, and
no section is always better than a wrong one.

Return the structured result only. Change no tracked file and commit nothing.
