# Shared calculation & privacy

Which records count toward the household's shared picture, and who controls
that. Related: [[assets]], [[members-and-permissions]], [[settings-and-sharing]],
[[snapshots-and-networth]].

## The rule

Whether a record counts toward shared totals, the forecast and flexible money is
**derived, never stored**. Spec v3.1 §11 is explicit that there must be no
`included_in_household_calculation` column — a stored flag would drift from the
two axes that actually decide it.

Single implementation: `isIncludedInSharedCalculation` in
`src/common/utils/shared-calculation.ts`.

```
excluded when  visibility_level = 'private'
            OR financial_nature = 'personal_private'
otherwise included
```

It is applied **twice on purpose**: in the repository `WHERE` clause so the hot
read path never loads excluded rows, and again inside the pure calculation
functions so the rule is unit-testable and a caller that forgets the SQL filter
still gets the right answer. `SHARED_CALCULATION_ASSET_WHERE` /
`SHARED_CALCULATION_VISIBILITY_WHERE` are the query-side encodings — keep them in
lockstep with the predicate.

## The two axes

They are independent, and conflating them is the classic bug.

**`financial_nature`** — whose money it fundamentally is (assets only):

| value | meaning |
|---|---|
| `household` | the household's money |
| `personal_included` | personal money the owner chose to count in the shared picture |
| `managed_for_household` | one person holds it on the household's behalf |
| `personal_private` | personal money that was never part of the shared picture |

**`visibility_level`** — how much the partner sees. `summary_only` and `grouped`
still **count** toward totals; they only limit detail, which is a presentation
concern, not a calculation one. Only `private` removes the record from
calculations.

The MVP UI exposes **three** choices (Hiện chi tiết → `detail`, Chỉ tính vào tổng
→ `summary_only`, Riêng tư → `private`) even though the DB stores four. Keep
`grouped` renderable so an existing record shows a label rather than an empty
select.

## Three different people

Never conflate these — spec §11:

- `created_by` — who typed the record in.
- `holder_member_id` — who holds / is responsible for the money.
- `privacy_owner_member_id` — who owns the right to keep it private.

New private records **must** set `privacy_owner_member_id`. Resolving it from
`created_by` is a **read-time legacy fallback only**, applied once as a backfill
in `20260812092000` / `20260812096000`; the person who enters a record is often
not the person it belongs to.

Carried by: `assets`, `money_events`, `attention_items`, `snapshot_asset_values`
(and `cashflow_events` from v3.1).

## Snapshots freeze the classification

`snapshot_asset_values` stores `financial_nature`, `holder_member_id` and
`privacy_owner_member_id` alongside the value (§17). Without that, changing an
asset to `personal_private` would silently change what every past snapshot
meant. See [[snapshots-and-networth]].

## Not permissions

`households.financial_management_mode` (who manages the money day to day) is
**personalization and analytics only**. It must never appear in an authorization
path — capability comes from `household_members.role` + `permission_level`. See
[[members-and-permissions]].
