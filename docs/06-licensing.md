# 6. Licensing (keep it commercial-safe)

This project may be used **commercially**, so we have a hard rule about the
open-source code we depend on. This page explains the rule, why we drive the
`claude` CLI instead of Anthropic's SDK, and how to check licenses yourself.

---

## The rule

**Only permissive licenses.** Prefer **MIT** and **Apache-2.0**; other clearly
permissive licenses (BSD-2/3-Clause, ISC, 0BSD, BlueOak, Unlicense/CC0) are also
fine — they all allow commercial use without forcing us to open-source our code.

**Never add a copyleft dependency.** No **GPL**, **AGPL**, **LGPL**, **MPL**,
**EPL**, or similar. These can legally require us to publish our source or carry
obligations we don't want in a commercial product. If a package you need is
copyleft, stop and find an alternative (or ask).

> Rule of thumb: permissive = "do what you want, keep the notice." Copyleft =
> "if you use this, your code may have to be open too." We only take the first kind.

---

## Why we don't use the Claude Agent SDK

The obvious way to drive Claude from Node is Anthropic's official
`@anthropic-ai/claude-agent-sdk`. We checked its license:

> © Anthropic PBC. **All rights reserved.** Use is subject to the Claude Code
> legal terms.

That is **proprietary**, not MIT/Apache — so we don't bundle it. Instead we run
the **`claude` command-line tool as an external subprocess** (see
[how orchestration works](03-how-orchestration-works.md)). The difference matters:

- **SDK approach:** proprietary Anthropic code would be a dependency shipped inside
  our app. ✗ against the rule.
- **CLI approach:** `claude` is a separate program the *user* installed and runs on
  their own subscription — we just talk to it, like a script calling `git`. Our
  shipped code stays 100% permissive. ✓

**Honest caveat:** running Claude at all means using Anthropic's proprietary
product under their Claude Code terms — there is no MIT/Apache way to run Claude
itself. Our rule is about the libraries *we bundle and ship*, and by that measure
the CLI approach keeps us clean. The end user is responsible for their own Claude
subscription and its terms.

---

## What actually ships vs. build tools

Two different things:

- **Runtime dependencies** — code bundled into the shipped app. Right now that's
  essentially just **React**, **React-DOM**, **Fluent UI**, and the **Electron**
  runtime — all **MIT**.
- **Dev dependencies** — build tooling (electron-vite, TypeScript, Vitest,
  electron-builder, …). These are a broader permissive mix (Apache-2.0, BSD, ISC,
  BlueOak) and are **not shipped** to users, only used to build. Still must be
  permissive, but the bar is about the same.

---

## How to check licenses yourself

Before adding a dependency, or when reviewing a PR that adds one:

```bash
pnpm licenses list            # every dependency grouped by license
```

Scan for anything that isn't clearly permissive. To hunt specifically for the
banned copyleft families:

```bash
pnpm licenses list | grep -iE 'GPL|AGPL|LGPL|MPL|EPL|CDDL'
```

If that prints nothing, you're clean. If a new package is copyleft or has a custom
"all rights reserved" license (like the Anthropic SDK), don't add it — raise it and
find a permissive alternative.

> As of the Phase 1 audit, the tree contained **no copyleft** licenses. Keep it
> that way.
