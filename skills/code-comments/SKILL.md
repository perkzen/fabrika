---
name: code-comments
description: How to comment code — why over what, plain language, one line inside a function, short doc comments on the exported interface. Use when writing or refactoring code, and as the comment rule in the review Standards axis.
---

# Code comments

Code tells you how; comments tell you why. A comment earns its line by carrying what the code cannot: the reason, the constraint, the trap. Readable code is its own explanation, so the first move is always a clearer name or a smaller function, and the comment covers only what remains.

A documented repo convention (`CLAUDE.md`, `CONTRIBUTING.md`, a lint rule) wins over these rules.

## Rules

- **Why over what.** Write the reason a line exists: the constraint it satisfies, the bug it avoids, the order it depends on. A comment that restates the code is deleted.
- **Plain language.** Short sentences, everyday words, written for the next reader arriving cold.
- **Inside a function: one line.** A comment inside a body is one line, directly above the statement it explains, and only where the reason is not obvious from the code.
- **Doc comments: the exported interface, kept short.** The language's doc-comment form on exported functions and types, one to three lines: what the caller must know that the signature does not say — invariants, error modes, units, ordering. Parameter lists that repeat the types are left out. Internal helpers rely on their name and signature.
- **Mark the traps.** Workarounds, non-obvious behaviour, and the issue or ADR behind them are exactly what comments are for: `// Stripe reuses the idempotency key on retry; see ADR-4`.
- **Keep them true.** When the code changes, the comment above it changes or goes.

Commented-out code is deleted; git keeps the history.

## Check

Cover the comment: if the code still reads, the comment goes. Cover the code: if the comment says something the code cannot, it stays.
