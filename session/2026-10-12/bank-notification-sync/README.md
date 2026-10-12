# Bank notification sync (iOS Shortcuts → inbox → money event)

- **Date**: 2026-10-12
- **Session folder**: `session/2026-10-12/bank-notification-sync/`
- **Status**: done; not yet run against a real database or a real iPhone

## What the task is

Accept Techcombank / VCB balance-change notifications from an iOS Shortcut,
parse them, match the household's linked account to a wallet, and record a
money event exactly once — otherwise park the notification in an inbox. Rules:
`memory/bank-sync.md`.

## Changes made

- `prisma/migrations/20261012090000_bank_notification_sync/` + `schema.prisma` —
  `bank_ingest_credentials`, `bank_external_sources`, `bank_source_links`,
  `bank_notification_events`; `money_events.origin` and
  `money_events.notification_event_id UNIQUE`.
- `src/modules/bank-sync/` (new) — ingest controller (`POST
  /api/v1/bank-notifications/ingest`, `@Public` + device-token guard),
  management controller under `households/:id/bank-sync`, parsers (TCB, VCB),
  ingest pipeline, atomic posting, inbox, raw-payload retention cron.
- `money-events` — `createMoneyEvent(..., { actorId, origin, notificationEventId })`;
  insert writes `created_by = COALESCE(actor, household creator)`.
- Billing — Premium feature `bank_sync` (`PlanLimits.bankSync`, reason `bank_sync`).
- `config/bank-sync.config.ts`, `logger.config.ts` (redact `accountNumber`,
  `rawPayload`), analytics bans `account` / `payload`.
- Deploy: `BANK_SYNC_HMAC_KEY` / `BANK_SYNC_PAYLOAD_KEY` in `deploy.yml` +
  `DEPLOYMENT.md`; Caddy caps the ingest body at 4 KB.

## Key decisions

- The inbox is its own table: `replayWalletBalance` ignores `status`, so a
  `pending_confirmation` money event would move the balance.
- Token bound to user + household; membership re-checked on every request.
- Raw payload AES-256-GCM, 30 days. OUT notifications held for review until a
  real redacted sample verifies each parser.

## Follow-ups

- Collect redacted OUT samples for both banks, then drop `OUT_UNVERIFIED`.
- Per-IP rate limit needs a Caddy plugin or an upstream WAF.
- Mobile UI not ported.
