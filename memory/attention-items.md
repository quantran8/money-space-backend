# Attention items

Signals worth the household's attention (spec §29). Related:
[[forecast-and-flexible-money]], [[cashflow-events]], [[data-freshness]],
[[snapshots-and-networth]].

## Two kinds of signal, and why the split matters

**Derived** signals describe the situation *right now*: a required payment is
overdue, the projected balance dips below zero, some asset values are stale.
They are recomputed on every read from the forecast bundle and **never written**.

**Persisting a derived signal would be a bug.** `attention_items` has no
`deleted_at` — `status = dismissed` IS the gone state. So once the condition
clears, a persisted row is indistinguishable from something the user
deliberately dismissed. The row outlives the fact it described and nothing can
tell the difference.

**Stored** signals are point-in-time observations that cannot be recomputed
later: someone flagged a money event, an asset moved sharply between two
snapshots. Those are facts about a moment, so a row is the right home.

| Rule code | Kind |
|---|---|
| `cashflow_required_due_soon`, `cashflow_overdue` | derived |
| `low_projected_balance`, `reserve_at_risk` | derived |
| `stale_data` | derived |
| `user_flagged`, `money_event_flagged` | stored |
| `asset_moved_sharply` | stored (needs a comparison base) |
| `amount_over_threshold` | dormant — see below |

## Reading: `stored ∪ derived`, minus dismissals

`GET /attention-items` merges both, tags each `source` + `ruleCode`, and drops
any derived signal with a matching dismissal tombstone. It costs **no extra
queries**: the derived half is computed from the forecast bundle already in
memory.

## Dismissing a derived signal

There is no row to update, so the dismissal is stored as a **tombstone**:
`status = 'dismissed'` carrying `rule_code` and (when the signal is about one)
`related_object_id`. `POST /attention-items/dismiss-derived` takes those in the
body rather than an id — a derived id (`derived:<ruleCode>:<scope>`) is a
synthetic key, not an addressable resource. PATCHing one 404s.

Matching is on **rule code AND related object**, so dismissing "rent is due
soon" does not also silence "electricity is due soon".

Derived ids must stay **stable across recomputation** — that is the entire
contract. If they embedded a date or an index, every dismissal would silently
stop working on the next read. Pinned by a test.

## Rules that need care

- **Only `required` outgoing money raises a signal.** A `planned` purchase is a
  choice; the household has not failed at anything by not spending money they
  merely intended to. Treating a plan like an obligation is exactly the nagging
  §29 forbids.
- **Check `wasClampedFromPast` BEFORE the due-soon window.** The forecast clamps
  an overdue occurrence onto today, so its `date` reads as today — without that
  check every overdue bill would report as "due in 0 days".
- **A recurring series collapses to ONE signal**, keyed on the source event.
  Monthly rent inside a 90-day horizon must not produce three copies of the same
  fact.
- **`reserve_at_risk` is suppressed when the balance is already negative.**
  Both would fire on the same dip; reporting it twice double-counts one worry,
  and `low_projected_balance` is the bigger fact.
- **`stale_data` is measured against the household's OWN cadence.** A household
  on `manual` never goes stale — see [[data-freshness]].

## No prose, ever

Derived signals carry `ruleCode` + `params` and leave `title`/`reason` null. The
client owns all copy (hard i18n mandate), and §29's calm-tone rules are a copy
concern — a backend-rendered "Khẩn cấp" can be neither translated nor softened.
`level` is likewise a code (`normal | important | urgent`); `DashboardService`
used to emit Vietnamese labels here and no longer does.

## Snapshots freeze STORED items only

`snapshots.attention_count` counts stored open items. A derived count is not
reproducible — it depends on a forecast that will have moved by the time anyone
reads the snapshot back, so freezing it would put a number in the row that
nothing can ever recompute or verify.

## `amount_over_threshold` stays dormant

It reads `households.config.largeEventThresholdVnd` (the `config` jsonb already
exists — zero migration). Until a household sets one, the rule does not fire.
**Do not invent a magic constant**: "large" for one household is a rounding error
for another, and guessing produces exactly the noisy, judgemental alerts §29 is
written to prevent.

## No cron in this cut

`@nestjs/schedule` is not a dependency, and a multi-instance deployment would
need advisory locking to avoid duplicate runs. Everything derived is computed on
read instead, which needs no scheduler at all.

## Where it lives in code

- **backend**: `src/modules/attention/` — `domain/attention-rules.ts` (pure, the
  unit-test surface), `attention.service.ts` (the merge), `attention.controller.ts`.
  Split out of `DashboardModule`, which returned attention as a decorated
  sub-field of the dashboard payload.
- **frontend-web**: consumed by `src/features/dashboard/` (pending rework).

## Routes

```
GET  /households/:hid/attention-items              → { items, storedCount, derivedCount }
POST /households/:hid/attention-items              (edit)   flag by hand
POST /households/:hid/attention-items/:id/seen     (any member — acknowledging is not editing)
POST /households/:hid/attention-items/:id/resolve  (edit)
POST /households/:hid/attention-items/:id/dismiss  (edit)
POST /households/:hid/attention-items/dismiss-derived (edit)
```
