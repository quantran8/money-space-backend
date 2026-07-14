import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import { AS_OF } from '../../common/seed/money-space.seed';
import { AssetsService } from '../assets/assets.service';
import type { Asset } from '../assets/entities/asset.entity';
import { MoneyEvent } from './entities/money-event.entity';
import {
  computeSavingInterestPeriods,
  deriveDirection,
  toMoneyEventCard,
} from '../../common/utils/money-space.utils';
import type { CreateMoneyEventDto } from './dto/create-money-event.dto';
import type { ListMoneyEventsQuery } from './dto/list-money-events.query';
import type { UpdateMoneyEventDto } from './dto/update-money-event.dto';
import { MONEY_EVENTS_REPOSITORY } from './repositories/money-events.repository.interface';
import type { MoneyEventsRepository } from './repositories/money-events.repository.interface';
import { SnapshotsService } from '../snapshots/snapshots.service';

@Injectable()
export class MoneyEventsService {
  constructor(
    @Inject(MONEY_EVENTS_REPOSITORY)
    private readonly moneyEventsRepository: MoneyEventsRepository,
    private readonly prisma: PrismaService,
    private readonly assetsService: AssetsService,
    private readonly snapshots: SnapshotsService,
  ) {}

  /**
   * Auto-snapshot after a money-event write commits. Refreshes each linked
   * wallet's line (they may have changed value), or falls back to a totals-only
   * recompute when no asset is linked. No-op when called inside a transaction
   * (nested under debt/payment) — the outermost caller fires it.
   */
  private async snapshotAfterEvent(
    householdId: string,
    assetIds: Array<string | undefined | null>,
  ): Promise<void> {
    const linked = [...new Set(assetIds.filter((id): id is string => !!id))];
    if (linked.length === 0) {
      await this.snapshots.onHouseholdChanged(householdId);
      return;
    }
    for (const assetId of linked) {
      await this.snapshots.onAssetChanged(householdId, assetId);
    }
  }

  async listMoneyEvents(householdId: string, query?: ListMoneyEventsQuery) {
    await this.moneyEventsRepository.assertHousehold(householdId);

    // Filters + limit are pushed into SQL (index-backed) instead of fetching the
    // whole ledger and filtering in memory. `total` preserves the previous
    // `items.length` semantics — the number of returned items (capped by the
    // limit when one is set).
    let limit: number | undefined;
    if (query?.limit) {
      const parsed = Number(query.limit);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
    }

    const { items } = await this.moneyEventsRepository.findMoneyEventsPage(
      householdId,
      {
        month: query?.month,
        type: query?.type,
        category: query?.category,
        limit,
      },
    );

    const cards = items.map((event) => toMoneyEventCard(event));
    return {
      householdId,
      items: cards,
      total: cards.length,
    };
  }

  async getMoneyEvent(householdId: string, eventId: string) {
    return toMoneyEventCard(await this.ensureMoneyEvent(householdId, eventId));
  }

  /**
   * Aggregate the money that moved in a month — the **source of truth** for the
   * events page's summary card (total in / out / net). The frontend must NOT
   * recompute these from the event list; it reads them from here.
   *
   * Only `inflow` / `outflow` events count toward thu/chi; `neutral` entries
   * (asset_update revaluations, transfers between own wallets, goal
   * contributions, sale bookkeeping) move no household money and are excluded —
   * the same rule `deriveDirection` encodes. `amount` is summed by `direction`
   * (not by sign) so it stays correct regardless of how the amount is stored.
   *
   * `month` defaults to the household's current AS_OF month when omitted, so a
   * caller can ask for "this month" without computing the date itself.
   */
  async getMoneyEventsSummary(householdId: string, month?: string) {
    await this.moneyEventsRepository.assertHousehold(householdId);
    const targetMonth = month ?? AS_OF.slice(0, 7);

    // Aggregated in one grouped query + one count, instead of fetching the whole
    // ledger and summing in memory. `neutral` events (asset revaluations,
    // transfers, goal contributions, sale bookkeeping) count toward
    // `recordedCount` but move no household money, so they are excluded from the
    // thu/chi sums — the same rule the old in-memory loop applied.
    const { recordedCount, totalIncome, totalOutcome } =
      await this.moneyEventsRepository.summarizeMonth(householdId, targetMonth);

    return {
      householdId,
      month: targetMonth,
      recordedCount,
      totalIncome,
      totalOutcome,
      netChange: totalIncome - totalOutcome,
    };
  }

  /**
   * Event types whose linked assets are plain cash moves: the source
   * (`fromAssetId`) and, where present, the destination (`toAssetId`) must both
   * be spendable wallets (cash / bank_account). A valued asset (gold, stock,
   * saving deposit, …) is never the wallet of an income/expense/transfer — it
   * changes hands via its own flow (sell / revalue). asset_sale / asset_update /
   * debt_update / goal_contribution deliberately link non-wallet assets and are
   * excluded. See [[money-events]].
   */
  private static readonly WALLET_ONLY_EVENT_TYPES: ReadonlySet<string> =
    new Set(['income', 'expense', 'transfer']);

  /**
   * For income / expense / transfer events, assert every linked asset is a
   * cash / bank_account wallet — money can only flow in or out of a spendable
   * balance. No-op for other event types (which link valued assets on purpose).
   *
   * `goal_contribution` is handled separately (`assertGoalContributionSource`):
   * it moves cash out of a spendable wallet INTO a savings goal, so its
   * `fromAssetId` is required and must be a wallet, but it links no valued
   * `toAssetId` — the goal is not an asset row.
   */
  private async assertWalletLinks(
    householdId: string,
    type: string,
    fromAssetId?: string,
    toAssetId?: string,
  ): Promise<void> {
    if (!MoneyEventsService.WALLET_ONLY_EVENT_TYPES.has(type)) {
      return;
    }
    if (fromAssetId) {
      await this.assetsService.assertWalletAsset(householdId, fromAssetId);
    }
    if (toAssetId) {
      await this.assetsService.assertWalletAsset(householdId, toAssetId);
    }
  }

  /**
   * A `goal_contribution` moves cash from a spendable wallet into a savings goal
   * (it debits `fromAssetId` in `applyWalletEffects` — direction stays `neutral`,
   * so it is NOT counted as spending in the thu/chi summary; it is a move between
   * the household's own pockets, like a transfer). The source **wallet is
   * mandatory** — a contribution that debits nothing would let progress rise for
   * free (the bug this fixes). It must be a `cash` / `bank_account` asset.
   * No-op for every other event type.
   */
  private async assertGoalContributionSource(
    householdId: string,
    type: string,
    fromAssetId?: string,
  ): Promise<void> {
    if (type !== 'goal_contribution') {
      return;
    }
    if (!fromAssetId) {
      throw new BadRequestException(
        'A goal contribution must specify the wallet the money comes from (fromAssetId).',
      );
    }
    await this.assetsService.assertWalletAsset(householdId, fromAssetId);
  }

  /**
   * `category` is required on a money event — it's the primary label now that
   * `title` is gone. Reject a missing / empty / whitespace-only category with a
   * 400. Used on create (always) and on update when the field is provided (an
   * edit must not blank an existing category).
   */
  private assertCategoryPresent(category?: string): void {
    if (!category || category.trim().length === 0) {
      throw new BadRequestException('A money event must have a category.');
    }
  }

  async createMoneyEvent(householdId: string, payload: CreateMoneyEventDto) {
    // `category` is mandatory — every event must be classified (the `title`
    // field was dropped, so category is the primary way an event is labelled).
    // Reject an empty/whitespace category up front (400). Internal callers
    // (debts, saving interest, revaluations) always pass a code, so this only
    // guards the user-facing create path.
    this.assertCategoryPresent(payload.category);
    // Income/expense/transfer only move cash — their linked assets must be
    // spendable wallets. Reject a non-wallet source/destination up front (400)
    // before opening the write transaction.
    await this.assertWalletLinks(
      householdId,
      payload.type,
      payload.fromAssetId,
      payload.toAssetId,
    );
    // A goal_contribution must debit a real wallet (see the method) — reject a
    // contribution with no / non-wallet source before touching any balance.
    await this.assertGoalContributionSource(
      householdId,
      payload.type,
      payload.fromAssetId,
    );
    // `insertMoneyEvent` asserts the household exists (and needs its row to
    // resolve `createdById`), so we don't assert it a second time here.
    const event: MoneyEvent = {
      id: this.moneyEventsRepository.createId('event'),
      householdId,
      amount: payload.amount,
      feeAmount: payload.feeAmount ?? 0,
      soldQuantity: payload.soldQuantity,
      soldValue: payload.soldValue,
      note: payload.note?.trim() ?? '',
      isoDate: payload.isoDate,
      type: payload.type,
      category: payload.category,
      direction: deriveDirection(payload.type, payload.direction),
      fromAssetId: payload.fromAssetId,
      toAssetId: payload.toAssetId,
      upcomingPaymentId: payload.upcomingPaymentId,
      debtId: payload.debtId,
      financialGoalId: payload.financialGoalId,
    };

    // An event moves money between wallets: the `fromAsset` is debited and the
    // `toAsset` credited (wallet assets only — see `applyWalletEffects`).
    //
    // Recording a repayment against a debt (an outflow money event linked to a
    // debt — e.g. marking a "Tra no: ..." upcoming payment as paid) must also
    // reduce that debt's remaining balance. The borrow inflow that `createDebt`
    // logs is a `debt_update` *inflow* and is excluded from the debt decrement
    // here — it raises the wallet, it must not pay the debt down.
    //
    // The event insert, the wallet moves and the debt decrement all land (or
    // roll back) together, so they run in one transaction — sequentially, since
    // they share the transaction's single connection.
    // The wallet/sale effects fan out into ~15-20 sequential round-trips
    // (credit/debit → upsertCurrentValuation), so raise the timeout well above
    // the 5s default to keep the interactive transaction from aborting mid-write
    // ("Transaction not found") and stranding its connection on the pooler.
    await this.prisma.runInTransaction(
      async () => {
        await this.moneyEventsRepository.insertMoneyEvent(event);
        await this.applyWalletEffects(event, 'apply');
        // An asset_sale also reduces the sold asset's position (and closes it on
        // a full sale). The wallet credit above already used the net amount
        // (amount - fee), so only the source-asset reduction remains.
        await this.applySaleEffects(event);
        // A repayment (debt-linked outflow) reduces the debt's outstanding and,
        // for editable relative/other debts, rebalances the next installment by
        // any over/under payment. The borrow inflow is a debt_update *inflow* and
        // is excluded — it raises the wallet, it must not pay the debt down.
        await this.applyDebtRepaymentEffects(householdId, event, -1);
      },
      { timeout: 30000, maxWait: 10000 },
    );
    await this.snapshotAfterEvent(householdId, [
      event.fromAssetId,
      event.toAssetId,
    ]);
    return toMoneyEventCard(event);
  }

  /**
   * Auto-credit the interest that has come due on every saving deposit in a
   * household. Idempotent — safe to call repeatedly (e.g. from a worker). See
   * {@link accrueSavingInterestForAsset}.
   */
  async accrueHouseholdInterest(householdId: string) {
    await this.moneyEventsRepository.assertHousehold(householdId);
    const { items } = await this.assetsService.listAssets(householdId);
    const deposits = items.filter(
      (asset) =>
        asset.type === 'saving_deposit' &&
        asset.status === 'active' &&
        asset.calculationTerm,
    );

    // Load the household's events ONCE and reuse the list across every deposit
    // for the idempotency check, instead of re-fetching the whole table per
    // deposit. `listAssets` above already loaded each deposit entity (with its
    // calculationTerm), so we pass those through too — no per-deposit re-read.
    // Safe because one deposit's accrual only ever writes interest events keyed
    // to its own assetId, so a deposit never needs to see events another deposit
    // creates in the same run.
    const existingEvents =
      await this.moneyEventsRepository.findMoneyEventsByHousehold(householdId);

    let credited = 0;
    for (const deposit of deposits) {
      credited += await this.accrueSavingInterestForDeposit(
        householdId,
        deposit,
        existingEvents,
      );
    }
    return { householdId, deposits: deposits.length, credited };
  }

  /**
   * Materialize the interest payouts that have come due on one saving deposit as
   * of `AS_OF`, creating a money event (+ dated valuation) per period.
   *
   * - `monthly`: one `income` event per elapsed month.
   * - `end_of_term`: a single event of the full-term interest, once matured.
   * - destination `wallet`: the event credits `receivingWalletId` (a cash/bank
   *   asset) net of fee, via the normal wallet effect.
   * - destination `principal`: the interest is capitalized into the deposit
   *   (compounds); the event is recorded for history as a `neutral` entry.
   *
   * **Idempotent**: each period is keyed by its `periodEnd` date; periods that
   * already have an interest event (same `fromAssetId` + `interest` category +
   * `isoDate`) are skipped, so re-running credits nothing new. Returns the number
   * of newly-credited periods.
   */
  async accrueSavingInterestForAsset(
    householdId: string,
    assetId: string,
  ): Promise<number> {
    // Single-asset entry point (worker route). Load the asset + the household
    // event list once, then delegate to the shared core. The household-wide
    // accrual path loads both in bulk and calls the core directly, avoiding a
    // per-deposit re-read.
    const asset = await this.assetsService.getAssetEntity(householdId, assetId);
    const existing =
      await this.moneyEventsRepository.findMoneyEventsByHousehold(householdId);
    return this.accrueSavingInterestForDeposit(householdId, asset, existing);
  }

  /**
   * Core accrual for one saving deposit. Takes the already-loaded `asset` entity
   * and the household's `existingEvents` list (for the idempotency check) so a
   * bulk caller can accrue every deposit without re-fetching either per deposit.
   */
  private async accrueSavingInterestForDeposit(
    householdId: string,
    asset: Asset,
    existingEvents: MoneyEvent[],
  ): Promise<number> {
    const assetId = asset.id;
    const term = asset.calculationTerm;
    if (asset.type !== 'saving_deposit' || !term) {
      return 0;
    }

    const periods = computeSavingInterestPeriods(term, AS_OF);
    if (periods.length === 0) {
      return 0;
    }

    // Idempotency: dates already credited for this deposit.
    const creditedDates = new Set(
      existingEvents
        .filter(
          (event) =>
            event.category === 'interest' && event.fromAssetId === assetId,
        )
        .map((event) => event.isoDate),
    );

    const toWallet = term.interestDestination === 'wallet';
    // The deposit's own value over time. When interest is capitalized into the
    // principal it compounds, so track a running value; when it's paid out to a
    // wallet the deposit stays at its principal.
    let depositValue = term.principalAmount;
    let credited = 0;

    for (const period of periods) {
      if (creditedDates.has(period.periodEnd) || !(period.amount > 0)) {
        continue;
      }
      if (!toWallet) {
        depositValue += period.amount;
      }
      const valuationAt = depositValue;

      // One period = one money event (+ valuation), all-or-nothing. The nested
      // createMoneyEvent runs a full wallet-effect chain, so raise the timeout
      // above the 5s default to avoid aborting the transaction mid-write and
      // stranding its connection.
      await this.prisma.runInTransaction(
        async () => {
          await this.createMoneyEvent(householdId, {
            note: `Lãi tiết kiệm: ${asset.name}`,
            amount: period.amount,
            isoDate: period.periodEnd,
            type: 'income',
            category: 'interest',
            // Wallet destination moves cash into the wallet (inflow);
            // capitalizing into principal is a bookkeeping entry that must not
            // move a wallet.
            direction: toWallet ? 'inflow' : 'neutral',
            fromAssetId: assetId,
            toAssetId: toWallet
              ? (term.receivingWalletId ?? undefined)
              : undefined,
          });

          if (!toWallet) {
            await this.assetsService.capitalizeSavingInterest(
              householdId,
              assetId,
              period.amount,
            );
          }

          // Record the deposit's own valuation at the payout date.
          await this.assetsService.writeSavingValuationAt(
            asset,
            period.periodEnd,
            valuationAt,
          );
        },
        { timeout: 30000, maxWait: 10000 },
      );
      credited += 1;
    }

    // The nested createMoneyEvent calls ran inside per-period transactions, so
    // their snapshot hooks skipped (isInTransaction). Fire once here, after all
    // commits: the deposit changed value, and a wallet destination was credited.
    if (credited > 0) {
      await this.snapshots.onAssetChanged(householdId, assetId);
      if (toWallet && term.receivingWalletId) {
        await this.snapshots.onAssetChanged(
          householdId,
          term.receivingWalletId,
        );
      }
    }

    return credited;
  }

  async updateMoneyEvent(
    householdId: string,
    eventId: string,
    payload: UpdateMoneyEventDto,
  ) {
    const event = await this.ensureMoneyEvent(householdId, eventId);
    // An edit that touches `category` must not blank it — category is required.
    // (Omitting the field entirely leaves the existing category untouched.)
    if (payload.category !== undefined) {
      this.assertCategoryPresent(payload.category);
    }
    // A repayment recorded against a bank/institution debt is locked — its
    // amount and schedule are fixed. Reject the edit before touching anything.
    // (The debt's own borrow inflow is not a repayment, so re-dating it on a
    // borrowedAt change still passes.)
    await this.assertRepaymentEditable(householdId, event);
    const nextType = payload.type ?? event.type;
    const next: MoneyEvent = {
      ...event,
      ...payload,
      id: event.id,
      householdId: event.householdId,
      note: payload.note?.trim() ?? event.note,
      type: nextType,
      direction: deriveDirection(
        nextType,
        payload.direction ?? event.direction,
      ),
      category: payload.category ?? event.category,
      isoDate: payload.isoDate ?? event.isoDate,
      amount: payload.amount ?? event.amount,
      feeAmount: payload.feeAmount ?? event.feeAmount,
      soldQuantity: payload.soldQuantity ?? event.soldQuantity,
      soldValue: payload.soldValue ?? event.soldValue,
    };

    // Same wallet-only rule as create: an edited income/expense/transfer must
    // still point its source/destination at cash / bank_account wallets. Reject
    // before touching any wallet balances.
    await this.assertWalletLinks(
      householdId,
      next.type,
      next.fromAssetId,
      next.toAssetId,
    );
    // An edited goal_contribution must still debit a wallet source.
    await this.assertGoalContributionSource(
      householdId,
      next.type,
      next.fromAssetId,
    );

    // Editing an event can change its amount or its linked wallets, so reverse
    // the old event's wallet moves and apply the new one's — together with the
    // row update, in one transaction so they can't diverge. For an asset_sale
    // the sold asset's position must also be reversed then re-applied, so the
    // asset ends up reflecting only the edited sale.
    // Reverse + re-apply is roughly double the wallet-effect round-trips of a
    // create, so raise the timeout above the 5s default to avoid aborting the
    // transaction mid-write and stranding its connection.
    // A revaluation (`asset_update`) edit is special: its `amount` is the **diff**
    // the record represents (e.g. −0,5tr when a wallet was revalued 5tr → 4,5tr),
    // NOT a wallet move and NOT a new absolute value. Editing it means editing
    // that diff, and the edit must:
    //   1. shift the asset's running balance by how much the diff itself moved
    //      (`newDelta − oldDelta`) — never overwrite the balance, so every
    //      later inflow/outflow that stacked on top of this record stays intact
    //      and the balance re-bases automatically; and
    //   2. re-stamp this record's own `asset_value_history` point at the value the
    //      asset held *at its date* (value-before-event + newDelta), not the
    //      current "now" balance.
    // `event.amount` is the OLD stored diff; `next.amount` is the NEW diff the
    // user entered (signed). See `AssetsService.applyRevaluationDeltaEdit`.
    if (event.type === 'asset_update' && next.type === 'asset_update') {
      const assetId = event.toAssetId;
      if (!assetId) {
        throw new BadRequestException(
          'Revaluation event has no linked asset to update',
        );
      }
      const oldDelta = event.amount;
      const newDelta = next.amount;
      await this.prisma.runInTransaction(
        async () => {
          // Persist the event with amount = the new diff, keeping date/note.
          await this.moneyEventsRepository.updateMoneyEvent(eventId, {
            ...next,
            amount: newDelta,
          });
          // Shift the asset's running balance by (newDelta − oldDelta) and
          // re-stamp its linked history point at the value-at-record-date.
          // `applyRevaluationDeltaEdit` recovers the value-before-record itself by
          // netting out this record's diff + every later event on the asset (it
          // reads the events after the update above, excluding this record by id).
          await this.assetsService.applyRevaluationDeltaEdit(
            householdId,
            assetId,
            {
              moneyEventId: eventId,
              eventDate: next.isoDate,
              oldDelta,
              newDelta,
            },
            { moneyEventId: eventId, valuationDate: next.isoDate },
          );
        },
        { timeout: 30000, maxWait: 10000 },
      );
      await this.snapshotAfterEvent(householdId, [assetId]);
      // `next.amount` was overwritten with the new diff in the DB — reflect that
      // in the returned card so the client sees the persisted diff.
      return toMoneyEventCard({ ...next, amount: newDelta });
    }

    // Editing an event can change its amount or its linked wallets, so reverse
    // the old event's wallet moves and apply the new one's — together with the
    // row update, in one transaction so they can't diverge. For an asset_sale
    // the sold asset's position must also be reversed then re-applied, so the
    // asset ends up reflecting only the edited sale.
    // Reverse + re-apply is roughly double the wallet-effect round-trips of a
    // create, so raise the timeout above the 5s default to avoid aborting the
    // transaction mid-write and stranding its connection.
    await this.prisma.runInTransaction(
      async () => {
        await this.applyWalletEffects(event, 'reverse');
        await this.reverseSaleEffects(event);
        // Undo the old event's debt-repayment effects (raise outstanding back,
        // un-rebalance the next installment) before re-applying the edited event's
        // — so an amount/link change nets out to exactly the new state. Reversal
        // uses the ORIGINAL event's amount/debt; the re-apply uses the new one.
        await this.applyDebtRepaymentEffects(householdId, event, 1);
        // Clear this event's old history points before re-applying: the edit may
        // have moved it to a different asset set, and `apply` only writes points
        // for the NEW assets — so any point on a dropped asset would otherwise be
        // stranded. `apply` below re-creates fresh points for the current assets.
        await this.assetsService.removeValuationsForEvent(eventId);
        await this.moneyEventsRepository.updateMoneyEvent(eventId, next);
        await this.applyWalletEffects(next, 'apply');
        await this.applySaleEffects(next);
        await this.applyDebtRepaymentEffects(householdId, next, -1);
      },
      { timeout: 30000, maxWait: 10000 },
    );
    // Union of old + new linked wallets — an edit can move the event between them.
    await this.snapshotAfterEvent(householdId, [
      event.fromAssetId,
      event.toAssetId,
      next.fromAssetId,
      next.toAssetId,
    ]);
    return toMoneyEventCard(next);
  }

  async deleteMoneyEvent(householdId: string, eventId: string) {
    const event = await this.ensureMoneyEvent(householdId, eventId);
    // A repayment on a bank/institution debt is locked — it can't be deleted by
    // hand either; the debt record is the only way to change its schedule.
    await this.assertRepaymentEditable(householdId, event);
    // Removing an event undoes the money it moved: reverse its wallet effects in
    // the same transaction as the soft-delete. For an asset_sale, also restore
    // the sold asset's position (and reopen it if the sale had closed it).
    // The wallet/sale reversal fans out into many sequential round-trips, so
    // raise the timeout above the 5s default to avoid aborting the transaction
    // mid-write and stranding its connection.
    await this.prisma.runInTransaction(
      async () => {
        await this.moneyEventsRepository.deleteMoneyEvent(eventId);
        await this.applyWalletEffects(event, 'reverse');
        await this.reverseSaleEffects(event);
        // Deleting a repayment restores the debt's outstanding and un-rebalances
        // the next installment it had shifted.
        await this.applyDebtRepaymentEffects(householdId, event, 1);
        // The reversal above re-touched this event's linked valuation points
        // (same event id). Removing the event should remove those points from
        // history entirely, so soft-delete them last.
        await this.assetsService.removeValuationsForEvent(eventId);
      },
      { timeout: 30000, maxWait: 10000 },
    );
    await this.snapshotAfterEvent(householdId, [
      event.fromAssetId,
      event.toAssetId,
    ]);
    return {
      deleted: true,
      eventId,
    };
  }

  /**
   * All non-deleted money events linked to a debt (newest first). Used by
   * `DebtsService.updateDebt` to detect whether a debt has history and to sum
   * recorded repayments (outflows) when recomputing outstanding on a correction.
   */
  async findMoneyEventsByDebt(householdId: string, debtId: string) {
    return this.moneyEventsRepository.findMoneyEventsByDebt(
      householdId,
      debtId,
    );
  }

  /** Whether an event is a repayment against a debt (a debt-linked outflow). */
  private isDebtRepayment(event: {
    debtId?: string | null;
    direction: string;
  }): boolean {
    return Boolean(event.debtId) && event.direction === 'outflow';
  }

  /**
   * Reject hand-editing (or deleting) a repayment recorded against a
   * **bank/institution** debt. Those debts have a fixed schedule and locked
   * events (see memory/debts.md): the only sanctioned way to change what was
   * paid is to update the debt record so the schedule recomputes. `relative` /
   * `other` debts are editable, so they pass. No-op for non-repayment events
   * (the borrow inflow, income/expense, etc.) — only debt-linked outflows lock.
   */
  private async assertRepaymentEditable(
    householdId: string,
    event: { debtId?: string | null; direction: string },
  ): Promise<void> {
    if (!this.isDebtRepayment(event)) {
      return;
    }
    const info = await this.moneyEventsRepository.findDebtRepaymentInfo(
      householdId,
      event.debtId as string,
    );
    if (info && info.lenderType === 'bank_institution') {
      throw new BadRequestException(
        'Repayments on a bank/institution debt are fixed and cannot be edited directly. Update the debt record instead.',
      );
    }
  }

  /**
   * Apply (`sign = -1`) or reverse (`sign = +1`) a debt repayment's effect on the
   * debt: always adjust the debt's `outstandingAmount` by the paid amount, and —
   * for `relative`/`other` debts with a fixed installment set — rebalance the
   * next unpaid upcoming payment by how far this payment ran over/under that
   * installment (overpay shrinks the next installment, underpay grows it; total
   * owed and installment count are unchanged). Bank/institution debts keep their
   * fixed schedule, so they never rebalance. Meant to run inside the caller's
   * transaction. No-op when the event is not a debt repayment.
   */
  private async applyDebtRepaymentEffects(
    householdId: string,
    event: { debtId?: string | null; direction: string; amount: number },
    sign: 1 | -1,
  ): Promise<void> {
    if (!this.isDebtRepayment(event)) {
      return;
    }
    const debtId = event.debtId as string;
    // Recording a repayment reduces outstanding (sign -1 → negative delta);
    // reversing one raises it back (sign +1 → positive delta).
    await this.moneyEventsRepository.adjustDebtOutstanding(
      householdId,
      debtId,
      sign * -event.amount,
    );

    const info = await this.moneyEventsRepository.findDebtRepaymentInfo(
      householdId,
      debtId,
    );
    // Only editable (non-bank) debts with a configured installment rebalance the
    // schedule. Without a fixed installment there's no baseline to over/under-pay
    // against, so nothing to carry forward.
    if (
      !info ||
      info.lenderType === 'bank_institution' ||
      !info.fixedPaymentAmount ||
      info.fixedPaymentAmount <= 0
    ) {
      return;
    }
    // over/under vs. the planned installment. Overpay (amount > installment) →
    // the next installment shrinks by the surplus; underpay → it grows by the
    // shortfall. Reversing flips the sign so an edit nets out cleanly.
    const overpayment = event.amount - info.fixedPaymentAmount;
    await this.moneyEventsRepository.adjustNextUnpaidPayment(
      householdId,
      debtId,
      (event as { isoDate?: string }).isoDate ?? AS_OF,
      sign * -overpayment,
    );
  }

  /**
   * Delete every money event linked to a debt, reversing each one's wallet
   * effects. Used by `DebtsService.deleteDebt` so removing a debt undoes both
   * the borrow inflow (a credit into the received-to wallet) and any repayment
   * outflows it recorded. Meant to run inside the caller's `runInTransaction`,
   * so it does not open its own — the debt delete owns atomicity.
   */
  async deleteMoneyEventsByDebt(
    householdId: string,
    debtId: string,
  ): Promise<void> {
    const events = await this.moneyEventsRepository.findMoneyEventsByDebt(
      householdId,
      debtId,
    );
    if (events.length === 0) {
      return;
    }
    // Soft-delete all the linked event rows in one bulk statement instead of N
    // per-row updates, then reverse each event's wallet effects (these can't be
    // bulked — every event moves different wallets).
    await this.moneyEventsRepository.deleteMoneyEventsByDebt(
      householdId,
      debtId,
    );
    for (const event of events) {
      await this.applyWalletEffects(event, 'reverse');
    }
  }

  /**
   * Move the money an event represents in or out of its linked wallets.
   *
   * `apply` debits the `fromAsset` and credits the `toAsset` by the event's
   * amount; `reverse` does the opposite (used when an event is edited or
   * deleted). Only wallet assets (`cash` / `bank_account`) actually change —
   * `credit/debitManualAsset` no-op for other asset types and for missing links,
   * so an expense with only a `fromAsset`, or an event linking a non-wallet
   * asset, is handled without special-casing here.
   *
   * Must run inside an existing `runInTransaction`: it issues wallet writes that
   * have to commit or roll back with the event write that triggered them.
   */
  private async applyWalletEffects(
    event: MoneyEvent,
    mode: 'apply' | 'reverse',
  ): Promise<void> {
    const { householdId, amount, fromAssetId, toAssetId } = event;
    // The wallet only ever sees the NET cash. For an asset_sale the fee never
    // lands in the account, so the receiving wallet is credited amount - fee.
    // Every other event type has feeAmount = 0, so this is a no-op change for
    // them and both the debit and credit stay at the full amount.
    const netAmount = Math.max(0, amount - (event.feeAmount ?? 0));
    // `apply`: from → out (debit), to → in (credit). `reverse` swaps the two.
    const debitId = mode === 'apply' ? fromAssetId : toAssetId;
    const creditId = mode === 'apply' ? toAssetId : fromAssetId;
    // Only `apply` writes a history point linked to this event (dated at the
    // event's date). `reverse` is a balance-only undo — it must NOT write a
    // point, otherwise an edit that moves the event to a different wallet would
    // strand a stale reversed point on the old wallet. Update/delete instead
    // soft-delete this event's linked points explicitly (see those callers).
    const context =
      mode === 'apply'
        ? { moneyEventId: event.id, valuationDate: event.isoDate }
        : undefined;
    if (debitId) {
      await this.assetsService.debitManualAsset(
        householdId,
        debitId,
        netAmount,
        context,
      );
    }
    if (creditId) {
      await this.assetsService.creditManualAsset(
        householdId,
        creditId,
        netAmount,
        context,
      );
    }
  }

  /**
   * Apply an asset_sale's effect on the sold asset: reduce its position (and
   * close it on a full sale). No-op for every other event type or when the sale
   * has no source asset. Runs inside the caller's transaction.
   */
  private async applySaleEffects(event: MoneyEvent): Promise<void> {
    if (event.type !== 'asset_sale' || !event.fromAssetId) {
      return;
    }
    await this.assetsService.sellPosition(
      event.householdId,
      event.fromAssetId,
      {
        quantitySold: event.soldQuantity,
        valueSold: event.soldValue,
        sellAll: false,
        soldOn: event.isoDate,
      },
      { moneyEventId: event.id, valuationDate: event.isoDate },
    );
  }

  /**
   * Reverse an asset_sale's effect on the sold asset: add the sold
   * quantity/value back and reopen the asset if the sale had closed it. No-op
   * for non-sale events. Runs inside the caller's transaction.
   */
  private async reverseSaleEffects(event: MoneyEvent): Promise<void> {
    if (event.type !== 'asset_sale' || !event.fromAssetId) {
      return;
    }
    // Balance-only undo — no valuation context, so it writes no history point.
    // Update/delete soft-delete this event's linked points explicitly.
    await this.assetsService.reverseSalePosition(
      event.householdId,
      event.fromAssetId,
      {
        quantitySold: event.soldQuantity,
        valueSold: event.soldValue,
      },
    );
  }

  private async ensureMoneyEvent(householdId: string, eventId: string) {
    // Querying by { id, householdId, deletedAt: null } already returns
    // undefined when the row (or its household) is absent, so a separate
    // assertHousehold round-trip is redundant — the NotFoundException below
    // preserves the 404 semantics.
    const event = await this.moneyEventsRepository.findMoneyEventById(
      householdId,
      eventId,
    );
    if (!event) {
      throw new NotFoundException(`Money event "${eventId}" was not found`);
    }
    return event;
  }
}
