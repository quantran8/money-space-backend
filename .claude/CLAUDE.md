# Working rules — backend

Stack-specific guidance lives in [../CLAUDE.md](../CLAUDE.md). These two rules
outrank anything there that disagrees.

## Code comments: short

A line or two, saying _what_ the line does, or a one-line caveat when something
is genuinely surprising.

Anything longer about business logic (nghiệp vụ) — why a rule exists,
trade-offs weighed, alternatives rejected, the measured numbers behind a
decision — goes in `memory/`, never inline. Leave a pointer from the code:

```ts
// Only `status` moves; `tier` stays premium. See memory/billing-and-entitlement.md.
```

When a change needs a paragraph of justification, that paragraph is a `memory/`
edit. Doc comments on classes, methods and types are held to the same length —
a ten-line essay is the same problem wearing `/** */`.

## Commit messages: 1–2 lines

Say what changed. No body paragraphs, no bullet lists, no rationale — the
reasoning belongs in `memory/`, which is where anyone reading the commit six
months later should be looking anyway.

**No `Co-Authored-By` trailer**, and no "Generated with Claude Code".

```
Charge a what-if slot per question, not per engine run
```
