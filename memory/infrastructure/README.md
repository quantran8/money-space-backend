# Infrastructure memory

The durable record of **how this backend runs** — the decisions behind the
runtime, not the domain it serves. Sibling of the business-logic files one level
up: those describe *what* the app computes, these describe *what it computes on*.

## Rules

- **Before changing anything in this layer**, read the relevant file here first.
  Every entry exists because a plausible-looking alternative was tried and cost
  something.
- **Whenever a task changes infrastructure**, update the corresponding file.
- One concern per file. Link related ones with `[[name]]`.
- **Backend-only.** Unlike `memory/*.md`, none of this is shared with
  `frontend-web` / `mobile-app` — they neither deploy nor cache this way.

## What belongs here

- Runtime topology (what runs where, and what talks to what).
- Operational contracts: fail-open vs fail-closed, retry and timeout budgets.
- Measured numbers behind a configuration value.
- Failure modes that are invisible until production, and how they were found.

## What does NOT belong here

- Domain rules → `memory/*.md`.
- Day-to-day conventions a contributor needs while editing code → `CLAUDE.md`.
  Where the two overlap, `CLAUDE.md` states the rule and links here for the why.

## Files

- [[logging]] — Pino → Alloy → Grafana Cloud.
- [[deployment]] — GitHub Actions → OCIR → the OCI VM, Caddy and TLS.
- [[database-connections]] — Supabase poolers, connection limits, transactions.
- [[caching]] — the fail-open Redis layer and its invalidation contract.
