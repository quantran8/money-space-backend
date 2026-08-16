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
- [asset-sale.md](asset-sale.md) — selling an asset (asset_sale money event, position reduction, status)
- [debts.md](debts.md) — debts / liabilities & interest maths
- [money-events.md](money-events.md) — money events (what already happened)
- [cashflow-events.md](cashflow-events.md) — expected future money in/out; the forecast's input
- [forecast-and-flexible-money.md](forecast-and-flexible-money.md) — running balance, lowest projected balance, flexible money, financial state, what-if
- [goals.md](goals.md) — financial goals & progress
- [attention-items.md](attention-items.md) — derived vs stored signals, dismissal tombstones
- [data-freshness.md](data-freshness.md) — how old the picture is; confirm-unchanged
- [members-and-lifecycle-safeguard.md](members-and-lifecycle-safeguard.md) — equal members; the one creator-only exception
- [invites.md](invites.md) — joining a household; why accept is NOT household-scoped
- [households-and-onboarding.md](households-and-onboarding.md) — household creation & onboarding
- [dashboard.md](dashboard.md) — overview / status buckets
- [snapshots-and-networth.md](snapshots-and-networth.md) — net-worth history & attention items
- [market-data.md](market-data.md) — market prices & FX reference data
- [money-formatting.md](money-formatting.md) — API returns raw numbers; client formats money
- [settings-and-sharing.md](settings-and-sharing.md) — household config, reminders, sharing
- [sharing-levels.md](sharing-levels.md) — everything counts; `detail` vs `summary_only` is presentation only
- [activity-log.md](activity-log.md) — the journal: what is logged, what deliberately is not
- [auth.md](auth.md) — authentication & session gating
