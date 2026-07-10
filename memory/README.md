# Business logic memory

This folder is the **durable source of truth for the app's business logic (nghiệp vụ)** — the domain flows, rules, and calculations that the code implements.

## Rules

- **Before changing anything that affects business logic**, read the relevant file(s) here first to understand the flow and the nghiệp vụ.
- **Whenever a task changes business logic**, update the corresponding file(s) here so they stay accurate.
- One concern per file, named clearly (e.g. `asset-valuation.md`, `household-sharing.md`, `transactions.md`).
- This applies to **all three repos** (`backend`, `frontend-web`, `mobile-app`). The business logic described here is the **shared domain** — keep it consistent across repos. When a rule changes in one repo, reflect it in the others.

## What belongs here

- Domain rules and invariants (e.g. how an asset's value is derived from its type).
- End-to-end flows (e.g. what happens when a user adds a transaction).
- Calculations / formulas and their inputs.
- Enum meanings and state machines.

## What does NOT belong here

- UI styling, component structure, framework config → those live in `CLAUDE.md` / `AGENTS.md` / `design.md`.
- Per-task change logs → those live in `session/` (frontend-web).

## File format

Each file is a focused Markdown doc. Link related files with `[[name]]` (the file's basename without `.md`).

```markdown
# <Domain concern>

## Overview
<what this is, in a sentence or two>

## Rules / flow
<the nghiệp vụ, step by step>

## Where it lives in code
<pointers to the implementing files in each repo>
```

## Index (by feature)

- [domain-overview.md](domain-overview.md) — product framing, global invariants, feature index (**start here**)
- [asset-valuation.md](asset-valuation.md) — core valuation engine (type → mode → value)
- [assets.md](assets.md) — assets feature (CRUD, liquidity buckets)
- [debts.md](debts.md) — debts / liabilities & interest maths
- [money-events.md](money-events.md) — money events + upcoming payments (unified events)
- [goals.md](goals.md) — financial goals & progress
- [members-and-permissions.md](members-and-permissions.md) — roles, permissions, invites
- [households-and-onboarding.md](households-and-onboarding.md) — household creation & onboarding
- [dashboard.md](dashboard.md) — overview / status buckets
- [snapshots-and-networth.md](snapshots-and-networth.md) — net-worth history & attention items
- [market-data.md](market-data.md) — market prices & FX reference data
- [settings-and-sharing.md](settings-and-sharing.md) — household config, reminders, sharing
- [auth.md](auth.md) — authentication & session gating
