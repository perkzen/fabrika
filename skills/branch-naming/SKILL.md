---
name: branch-naming
description: Choose the type, slug, and preview flag for a ticket's branch. Use when the host asks for a branch name at the start of a run.
---

# Branch naming

The host builds the branch from the pattern in `.fabrika/config.json` — for example `domen/{type}/{ticket}/{slug}`, with the preview prefix in front when preview is true — and creates it. You supply three values: **type**, **slug**, **preview**. Nothing else happens in this step: no branch, no checkout, no file.

## Type

From the ticket's labels first, its wording second:

- feature / story / improvement → `feat`
- bug / fix / regression → `fix`
- chore / task / maintenance / dependency bump → `chore`
- unclear → `feat`

## Slug

A kebab-case phrase a reviewer reads at a glance:

- 2–4 words, 30 characters at most, lowercase, single hyphens, no leading or trailing hyphen.
- Drop filler (a, an, the, for, to, of, new, implement, add, update) unless it carries meaning, and anything the type or ticket id already says.
- Keep the noun that names the feature; drop the verb when the type already implies it.

| Title | Slug |
| --- | --- |
| Implement new design for referrals | `new-referrals-design` |
| Login times out on slow networks | `login-timeout` |
| Bump Effect to 4.0.0-rc.3 | `effect-rc3` |
| Add ability for admins to export users as CSV | `admin-user-csv-export` |

## Preview

`preview/*` branches get a Vercel preview deployment without waiting for a PR; the Ignored Build Step lets them through and nothing else. Preview is **true** when the change has a user-visible surface a reviewer would open in a browser: pages, components, styling, copy, client-side behaviour. It is **false** for backend-only, CLI, tooling, tests, docs, and config changes. When the title does not settle it, look at the code the ticket touches.

## Output

Return `{ "type", "slug", "preview" }` as the structured output.
