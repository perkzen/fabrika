---
name: research
description: Investigate a question against primary sources and write the findings, with citations, to .fabrika/work/research/. Use when a spec, plan, or grill needs a fact about a library, API, or platform that the codebase cannot answer.
---

# Research

Spin up a **background sub-agent** to do the reading, so the stage keeps working.

Its job:

1. Investigate the question against **primary sources** — official docs, the library's source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it. The installed version in the repo's lockfile is the version that counts.
2. Write the findings to `.fabrika/work/research/<topic>.md`: the question, the answer, and one citation per claim (URL or file path plus version).
3. Mark what the sources did not settle as **open**, so the caller records an assumption rather than a fact.

The caller folds the answer into its own record — a spec Assumption, a plan Decision — with a pointer to the file.
