---
status: accepted
---

# Capture images are uploaded as GitHub attachments, not hosted in the repository

A pull request body can only show an image it has a URL for, and a screenshot
fabrika just took has none. `gh pr create --attach` (GitHub CLI 2.99.0,
2026-09-01) uploads a local file and rewrites the body's reference to it in
place, and GitHub documents the result as visible to exactly the people who can
see the repository — the only candidate with that sentence written down. So a
capture's images are uploaded at the moment the pull request is opened, and
nothing is committed, branched or released. The price is a floor: a host with a
`gh` older than 2.99.0 has no `--attach`, so the Before / After section is left
out rather than posted with paths nobody can open.

## Considered Options

- **Commit the images on the pull request's own branch** and reference them as
  `../blob/<ref>/<path>?raw=true`. Always renders, and documented — rejected
  because it puts binaries in the repository's history forever and into the very
  diff the review loop exists to read, and the link breaks when the branch is
  deleted on merge.
- **A `fabrika-captures` branch** pushed to the same remote. Keeps the images
  out of the merged tree — rejected because it still writes binaries to the
  remote forever, it can trip any workflow the target repo triggers on a plain
  push, and it makes fabrika the owner of a branch nobody asked for.
- **A release asset** via `gh release upload`. Rejected: it manufactures a
  release for a screenshot, and no GitHub documentation says a private repo's
  `browser_download_url` renders inline for an authorised viewer.
- **`raw.githubusercontent.com`**, with or without a `?token=`. Rejected on
  confidentiality, not convenience: the bare form renders for nobody, and the
  tokenised form serves a private repository's screenshot to anyone on the
  internet who has the link.
- **Any host outside GitHub.** Rejected by construction — GitHub proxies
  external images through Camo, which fetches anonymously and therefore cannot
  reach anything a private repository would want shown.

## Consequences

- fabrika requires push access to the repository to attach anything; GitHub
  answers a reader with a 404 rather than a 403, so that error is translated
  rather than surfaced raw.
- An upload is irreversible, so nothing cancellable may sit between the upload
  and the pull request being created.
- The pull-request step reads the posted body back once and re-posts it without
  the section if an attachment path survived the rewrite, because a body full of
  `/Users/...` is the failure that would otherwise ship unnoticed. The step, not
  the forge: `open` is handed one opaque string and cannot know where the section
  is inside it.
- An upload that GitHub rejects would otherwise fail the whole run, so opening
  the pull request is retried once with neither the attachments nor the section.
