# Asset sale (Bán tài sản)

Selling an asset — in whole or in part — for cash. Modeled as a single
`money_event` of type `asset_sale`, `direction = neutral`, which moves value out
of the sold asset and into a wallet, minus any sale fee. Selling is **not** the
same as re-valuing an asset (see [[asset-valuation]]): a valuation only changes
what the asset is worth on paper (no money moves, no wallet changes); a sale
realizes value into cash and reduces the position.

## Why `direction = neutral`

A sale converts one asset (gold) into another (cash in a bank account). Total net
worth does **not** change from the conversion itself — it only drops by the fee
(and by any gap between the sale price and the last valuation). So the money
event is `neutral`, consistent with `asset_purchase` and `transfer`. Only the
fee is a real net-worth reduction; it is recorded as the event's `feeAmount`, not
as the event's `direction`. See [[money-events]] for direction derivation
(everything except income → inflow and expense/payment_paid/debt_update →
outflow falls through to `neutral`).

## What a sale does (atomic — one transaction)

For "bán 2 chỉ vàng SJC, nhận 24.9M vào VCB, phí 100k":

1. **Create `money_events`**
   - `event_type = asset_sale`
   - `direction = neutral`
   - `amount` = **gross sale proceeds** (25,000,000) — số tiền bán trước phí
   - `fee_amount` = 100,000 (**new column**, default 0, ≥ 0)
   - `from_asset_id` = the asset sold (Vàng SJC)
   - `to_asset_id` = the wallet that receives the money (Tài khoản VCB)
   - `event_date` = ngày bán
   - `title` / `description` = "Đã bán 2 chỉ vàng SJC" / note

2. **Credit the receiving wallet by the NET amount** (`amount − fee_amount` =
   24,900,000). This is the important deviation from a normal money event:
   `applyWalletEffects` credits `toAsset` by the full `amount`. For an
   `asset_sale` the wallet must be credited by `amount − feeAmount`, because the
   fee never lands in the account. See "Fee handling" below.

3. **Reduce the sold asset's position**
   - **Market asset** (gold/stock/crypto/fund/foreign_currency/bond that has an
     `asset_market_positions` row): decrement `quantity` by the quantity sold
     (5 chỉ → 3 chỉ). Quantity is floored at 0 and may never go negative.
     `current_value` is recomputed from the new quantity (see
     [[asset-valuation]]).
   - **Non-position asset** (real_estate / investment — manual valuation, no
     quantity): reduce `current_value` (and the backing `manualValue`) by the
     portion sold. A partial sale lowers the value by the sold amount; a full
     sale drives it to 0.

4. **Write an `asset_valuation`** for the sold asset dated `event_date`, recording
   the post-sale value (mirrors the normal valuation write in
   [[asset-valuation]] `upsertCurrentValuation`).

5. **On a full sale, close the asset** (see "Full vs partial" below).

6. **Write `audit_logs` `money_event.created`** (as all money events do).

The event insert, the wallet credit, the position/valuation update and the
status change all land or roll back together — one `runInTransaction`, writes
sequential (per the atomicity rule in backend `CLAUDE.md`).

## Fee handling — `feeAmount` on `money_events`

- New nullable-with-default column `fee_amount numeric(14,2) not null default 0
  check (fee_amount >= 0)` on `money_events`. It is meaningful for `asset_sale`
  (and later `asset_purchase`); 0 for every other event type.
- `amount` stays the **gross** proceeds (25M) so "đã bán được bao nhiêu" is
  visible directly and reports can sum gross vs fee.
- The wallet is credited `amount − feeAmount`. For `asset_sale` the wallet-effect
  path must special-case the credit to use the net amount; for all other event
  types `feeAmount = 0` so `amount − feeAmount == amount` and behavior is
  unchanged. This keeps a single code path.
- **Net-worth impact of a sale = −feeAmount** (asset down by `amount`, wallet up
  by `amount − fee`). This is the only leak, and it is intended.

## Full vs partial sale — asset lifecycle

New `assets.status` enum column `active | sold | closed`, default `active`, plus
`sold_at timestamptz` (nullable). Rationale: the schema currently has **no**
asset lifecycle flag (only `deleted_at` soft-delete), so "đã bán hết nhưng vẫn
xem được lịch sử" needs a real status.

- **Partial sale** — position/value reduced, `status` stays `active`,
  `sold_at` stays null. Asset remains in the active list.
- **Full sale** — quantity → 0 (or manual value → 0), `current_value → 0`,
  `status = sold`, `sold_at = event_date`. The asset row is **kept, not
  deleted**, so the household can still:
  - see the sale history,
  - keep the link from the `asset_sale` money event's `from_asset_id`,
  - preserve old snapshots (snapshots are immutable — a later sale must never
    rewrite a past `snapshot_asset_values` row; see [[snapshots-and-networth]]),
  - know the household once owned this asset.
- A `sold` asset is excluded from the active-assets total and the liquidity
  buckets, but still retrievable (e.g. a "sold / archived" filter on the assets
  list). It is distinct from `deleted_at` (soft-deleted = removed entirely).
- `closed` is reserved for matured/terminated instruments (parallels
  `asset_calculation_terms.status`); a user-initiated sale uses `sold`.

## Sellable asset types

Only these can be sold through this flow:
`gold`, `stock`, `crypto`, `fund`, `foreign_currency`, `bond`,
`real_estate`, `investment`.

- The first six are **market-priced** and carry an `asset_market_positions`
  row → partial sale = reduce `quantity`.
- `real_estate` and `investment` are **manual** → partial sale = reduce
  `current_value` / `manualValue` by the sold amount.

Excluded: `cash`, `bank_account` (these are wallets — move money via a
`transfer`, not a sale), `saving_deposit`, `certificate_of_deposit`,
`loan_receivable` (these mature/close, not "sold"), `insurance`, `other`.

## Source-of-truth split (unchanged, reaffirmed)

- `assets` / `asset_market_positions` = **hiện tại còn giữ bao nhiêu** (position,
  and now `status`).
- `asset_valuations` = tài sản đáng giá bao nhiêu tại từng thời điểm.
- `money_events` = việc mua/bán đã xảy ra khi nào, bao nhiêu tiền, tiền đi đâu
  (now also the fee).
- `snapshots` = tại thời điểm snapshot household có tài sản gì (immutable).

## UI entry points

- **Primary**: the assets list row menu gains a "Bán" (sell) action next to
  Edit/Delete. It opens a sale form pre-scoped to that asset (nguồn đã biết).
  Only shown for sellable types.
- **Secondary**: the money-events "Thêm sự kiện" quick-action picker gains
  "Bán tài sản". Choosing it first makes the user pick the source asset, then
  shows the same sale form.
- The money-events timeline shows the sale ("Đã bán 2 chỉ vàng SJC · Nhận
  24.9M vào VCB · Phí 100k") so the user can see history, why the asset dropped,
  where the money went, edit the note, cancel/adjust, and filter all
  buy/sell events.

## Recording the resolved sold amount — `sold_quantity` / `sold_value`

So that editing or cancelling a sale can restore the position **exactly**, the
`asset_sale` money event persists what it actually removed:

- `money_events.sold_quantity numeric(20,8)` — for a market asset, the quantity
  sold (e.g. 2 chỉ). NULL for manual / non-sale events.
- `money_events.sold_value numeric(14,2)` — for a manual asset (real_estate /
  investment), the value removed. NULL for market / non-sale events.

The frontend resolves these at sale time (a "bán toàn bộ" sends the *current*
quantity/value, not a `sellAll` flag), so reversal simply adds the stored number
back — no need to re-derive from price. `amount` (gross proceeds) is independent
of `sold_quantity`: proceeds is what the buyer paid; sold_quantity is how much of
the position left.

## Editing / cancelling a sale

Because the wallet credit, the position reduction and the status change are
driven off the money event, editing or deleting the `asset_sale` event reverses
all three inside one transaction — the same apply/reverse discipline
`updateMoneyEvent` / `deleteMoneyEvent` already use for wallet effects:

- **Create** → `applyWalletEffects(apply)` credits the wallet net, then
  `applySaleEffects` reduces the sold asset's position (closing it on a full
  sale).
- **Update** → reverse both (wallet + position) for the old event, write the
  row, then apply both for the new event.
- **Delete** → soft-delete the row, reverse the wallet credit, and
  `reverseSalePosition` adds `sold_quantity`/`sold_value` back and reopens the
  asset if the sale had marked it `sold`.

The wallet side uses **net** (`amount − fee_amount`) via `applyWalletEffects`;
`fee_amount` is 0 for every non-sale event, so that one code path is unchanged
for them. The position side (`applySaleEffects` / `reverseSaleEffects`) is a
no-op for every event type except `asset_sale`.

## Sale form fields (UI)

- Số lượng bán (market assets) **or** Số tiền bán / phần giá trị bán
  (manual assets) — with a "bán toàn bộ" shortcut.
- Số tiền thực nhận (gross proceeds) → event `amount`.
- Tiền nhận vào (wallet select: cash / bank_account assets) → `to_asset_id`.
- Phí bán → `fee_amount` (default 0).
- Ngày bán → `event_date`.
- Ghi chú (optional) → `description`.
- Validation: quantity sold ≤ current quantity; `fee_amount ≤ amount`;
  `from_asset ≠ to_asset`.
