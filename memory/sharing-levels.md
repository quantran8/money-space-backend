# Sharing levels

How much of a record the shared picture shows. Related: [[assets]],
[[members-and-lifecycle-safeguard]], [[activity-log]],
[[forecast-and-flexible-money]], [[snapshots-and-networth]].

> Replaces the deleted `shared-calculation-and-privacy.md`. The rule that file
> described — records excluded from the household's own figures — is gone.

## The rule

**Everything recorded in Money Space counts toward every shared figure.** Net
worth, the forecast, flexible money, snapshot totals: all computed over the same
set of records, with no exclusions. There is no `isIncludedInSharedCalculation`,
no `financial_nature`, no `privacy_owner_member_id`, and no `private` level.

`visibility_level` survives with exactly two values and affects **presentation
only**:

| value | meaning |
|---|---|
| `detail` | the shared list shows the source, the amount and the holder |
| `summary_only` | the amount is counted; the specifics are folded away |

## Why it is not an access boundary

Both partners have the same rights and **either can switch any record to
`detail`** with one edit. Server-side redaction would therefore be bypassable by
design — security theatre with a redaction layer in every mapper as its price.

So folding is a courtesy about attention — *"don't make me explain this line,
just count it"* — and it applies to **everyone, including the person who set
it**. That symmetry is the point: what I see is what they see, which is what
makes the setting trustworthy without a permission system behind it. Changing it
is journalled.

The way to see a folded record's specifics is to switch it back to `detail`.
There is no "peek" affordance, and there must not be one.

## Where the fold is applied

Presentation, all client-side:

- `normalizeVisibility` (frontend `asset-classification.ts`) — the single read
  boundary; legacy `grouped`/`private` fold to `summary_only`, never to `detail`.
- Asset list row and asset detail page.
- The journal withholds a folded record's **name and amount** — it is the one
  place both partners are guaranteed to look, so leaking specifics there would
  undo the fold at the worst possible spot. That a change *happened* is still
  always shown.

**The seam, if this ever must become real concealment** (a third member, an
exported PDF): the only place to add redaction is
`money-space.mapper.ts` (`mapAsset`, `mapCashflowEvent`) plus
`prisma-snapshots.repository.ts` `toDetail`. Nothing else reads these fields.

## The bug this fixed

The old exclusion rule ran in the forecast and flexible money but **not** in
dashboard net worth, the asset summary, or snapshot totals. Two figures on the
same screen disagreed about how much money the household had, undocumented.
`src/modules/forecast/domain/shared-figures.spec.ts` pins them together — if
anyone reintroduces an exclusion on one path, that test fails.

## Still carried, and different

`holder_member_id` — **who is responsible for** the money. Not a privacy field.
It is what the members list now reports ("phụ trách N nguồn tiền") and what a
snapshot still freezes alongside the value (§17).
