---
name: security
description: Security review of the branch diff — find each weakness, fix or accept it, record it in .fabrika/work/security.md. Use after implementation, before code review.
---

# Security review

Review `git diff <base>...HEAD` the way an attacker reading the change would, fix what matters, and leave a record a human can check.

## Checklist

Match each item against every hunk; the change is where new risk enters. Each reads *what it is* → *how to fix*.

- **Injection** — shell, SQL, LDAP, template, or command strings built from input. → parameterise; pass argv arrays, not shell strings.
- **Path handling** — file paths built from input, `..` traversal, symlinks followed. → resolve, then check the path stays under the intended root.
- **Trust boundaries** — new inputs (HTTP params, webhook bodies, env, files, MCP or tool results) used without validation. → validate at the boundary with the repo's schema tool.
- **Authn/authz** — new endpoints, handlers, or commands without the checks their siblings have. → mirror the sibling's guard.
- **Secrets** — keys, tokens, passwords in code, config, logs, error messages, URLs, or process arguments. → env or secret store; redact logs.
- **Sensitive data exposure** — PII or credentials in logs, stack traces, responses, analytics. → drop or redact at the point of logging.
- **Unsafe deserialisation / eval** — `eval`, `new Function`, YAML or pickle load of untrusted input, prototype pollution through deep merge. → safe parsers, schema-validated input.
- **SSRF / open redirect** — outbound requests or redirects to input-controlled URLs. → allowlist hosts.
- **XSS** — HTML built from input, `dangerouslySetInnerHTML`, unescaped templates. → escape at render; trusted-types where the framework has them.
- **Crypto** — home-made hashing, weak algorithms, static IVs, `Math.random` for tokens. → the platform's crypto primitives.
- **Dependencies** — new packages: needed, maintained, pinned? → stdlib or an existing dependency first.
- **Resource limits** — unbounded reads, loops, recursion, or concurrency driven by input. → caps and timeouts.
- **Permissions and defaults** — files created world-readable, CORS `*`, debug flags on, permissive fallbacks. → least privilege, fail closed.

## Record and fix

Write `.fabrika/work/security.md`, one entry per finding:

```
## <finding>
- **Severity**: High | Medium | Low
- **Where**: file:line
- **Risk**: what an attacker gets
- **Status**: fixed (<commit>) | accepted: <reason>
```

Fix every High and Medium, test-first where the fix changes behaviour (`fabrika:tdd`), one commit per finding with a message starting `fix(security):`. A Low is fixed when the fix stays inside one file, otherwise accepted with the reason. "No findings" is a valid file, with one line on what was checked.

## Done

Every finding has a Status; typecheck and the test suite are green locally; everything is committed.
