# Activity log (Nhật ký)

Related: [[members-and-lifecycle-safeguard]], [[sharing-levels]], [[dashboard]].

## Why it is load-bearing

Removing the permission hierarchy moved accountability here. Nobody is prevented
from changing anything, so **what makes a change answerable is that the other
person can see it happened.** This is a product surface, not an admin tool —
which is why the read endpoint is ungated beyond membership.

## Contract

`AuditService.record(householdId, { actorId, action, entityType, entityId,
impact, details })` is the only way anything reaches the table. Writes join the
caller's transaction via `AsyncLocalStorage`, so an entry can never describe a
change that rolled back.

`GET /api/households/:householdId/activity?limit=&before=` — cursor on
`created_at DESC`, matching the existing index. Fetches `limit + 1` so "is there
more" costs no second query; `limit` is clamped, never trusted.

**Codes, never sentences.** The backend emits an `action` code plus structured
metadata; the client builds every word. Same contract as the forecast's
`CalculationAssumption`. A server-rendered string could not be translated.

```
metadata.impact = { metric: 'liquid' | 'net_worth' | 'flexible_money'
                            | 'upcoming_outgoing',
                    delta: <signed VND> }
```

`delta` is the record's **direct** change, not a before/after re-run of the
forecast — that would double the cost of every write for a column the client
only labels.

## Rules

- **A change that cannot state its impact should not be logged.** The impact
  column is what separates this from a technical audit log.
- **Routine `income` / `expense` money events are deliberately NOT logged.**
  Logging every purchase would make this the expense tracker the product
  explicitly is not. `adjustment` and `debt_update` are in scope — they move the
  picture and are not purchases.
- **`actor_id = NULL` means the system**, and is the correct value for worker /
  cron / migration writes. Never substitute a plausible person: once the feed is
  user-visible a wrong name is a lie the household can read. (The debts
  repository used to write `households.created_by` for exactly this reason and
  was corrected.)
- **A `record.visibility_changed` entry carries no impact and no amount.**
  Nothing moved — and printing the value in the entry that folded the record
  would undo the fold. Its impact line leads with "Vẫn tính vào tổng".
- Timestamps render **day-granular**. A precise time would read as surveillance
  of the other person's evening rather than a record of the household's money.

## State

Vocabulary and impact shapes are defined for 24 actions in
`src/common/audit/audit.types.ts`. Wired write sites today: asset deletion, plus
the lifecycle set (household created/deleted/steward transferred, invite
created, member joined) and snapshot/debt corrections inherited from the older
writers. **Not yet threaded**: `asset.value_updated`, the cashflow actions, and
`record.visibility_changed` — each needs the request actor pushed through its
service. That is the next piece of work.

The three `protected_reserve.*` actions were never threaded either, and are now
gone with the concept. Rows written before the removal keep their action string:
`audit_logs.action` is TEXT, and the journal renders from the client's own copy
table, so old history still reads as a sentence.

`audit_logs` is append-only, never soft-deleted, and has **no retention
policy**. At the write frequency above a busy household produces roughly 10–30
rows a month, so this is fine indefinitely — but it is unbounded, and that is a
deliberate choice rather than an oversight.
