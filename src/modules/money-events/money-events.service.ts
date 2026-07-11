import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import { AS_OF } from '../../common/seed/money-space.seed';
import { AssetsService } from '../assets/assets.service';
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

@Injectable()
export class MoneyEventsService {
  constructor(
    @Inject(MONEY_EVENTS_REPOSITORY)
    private readonly moneyEventsRepository: MoneyEventsRepository,
    private readonly prisma: PrismaService,
    private readonly assetsService: AssetsService,
  ) {}

  async listMoneyEvents(householdId: string, query?: ListMoneyEventsQuery) {
    await this.moneyEventsRepository.assertHousehold(householdId);
    let items =
      await this.moneyEventsRepository.findMoneyEventsByHousehold(householdId);

    if (query?.month) {
      const month = query.month;
      items = items.filter((event) => event.isoDate.startsWith(month));
    }
    if (query?.type) {
      items = items.filter((event) => event.type === query.type);
    }
    if (query?.category) {
      items = items.filter((event) => event.category === query.category);
    }
    if (query?.limit) {
      const limit = Number(query.limit);
      if (Number.isFinite(limit) && limit > 0) {
        items = items.slice(0, limit);
      }
    }

    return {
      householdId,
      items: items.map((event) => toMoneyEventCard(event)),
      total: items.length,
    };
  }

  async getMoneyEvent(householdId: string, eventId: string) {
    return toMoneyEventCard(await this.ensureMoneyEvent(householdId, eventId));
  }

  async createMoneyEvent(householdId: string, payload: CreateMoneyEventDto) {
    // `insertMoneyEvent` asserts the household exists (and needs its row to
    // resolve `createdById`), so we don't assert it a second time here.
    const event: MoneyEvent = {
      id: this.moneyEventsRepository.createId('event'),
      householdId,
      title: payload.title.trim(),
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
    const repaysDebt = Boolean(event.debtId) && event.direction === 'outflow';
    await this.prisma.runInTransaction(async () => {
      await this.moneyEventsRepository.insertMoneyEvent(event);
      await this.applyWalletEffects(event, 'apply');
      // An asset_sale also reduces the sold asset's position (and closes it on a
      // full sale). The wallet credit above already used the net amount
      // (amount - fee), so only the source-asset reduction remains.
      await this.applySaleEffects(event);
      if (repaysDebt) {
        await this.moneyEventsRepository.reduceDebtOutstanding(
          householdId,
          event.debtId as string,
          event.amount,
        );
      }
    });
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

    let credited = 0;
    for (const deposit of deposits) {
      credited += await this.accrueSavingInterestForAsset(
        householdId,
        deposit.id,
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
    const asset = await this.assetsService.getAssetEntity(householdId, assetId);
    const term = asset.calculationTerm;
    if (asset.type !== 'saving_deposit' || !term) {
      return 0;
    }

    const periods = computeSavingInterestPeriods(term, AS_OF);
    if (periods.length === 0) {
      return 0;
    }

    // Idempotency: dates already credited for this deposit.
    const existing =
      await this.moneyEventsRepository.findMoneyEventsByHousehold(householdId);
    const creditedDates = new Set(
      existing
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

      // One period = one money event (+ valuation), all-or-nothing.
      await this.prisma.runInTransaction(async () => {
        await this.createMoneyEvent(householdId, {
          title: `Lãi tiết kiệm: ${asset.name}`,
          amount: period.amount,
          isoDate: period.periodEnd,
          type: 'income',
          category: 'interest',
          // Wallet destination moves cash into the wallet (inflow); capitalizing
          // into principal is a bookkeeping entry that must not move a wallet.
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
      });
      credited += 1;
    }

    return credited;
  }

  async updateMoneyEvent(
    householdId: string,
    eventId: string,
    payload: UpdateMoneyEventDto,
  ) {
    const event = await this.ensureMoneyEvent(householdId, eventId);
    const nextType = payload.type ?? event.type;
    const next: MoneyEvent = {
      ...event,
      ...payload,
      id: event.id,
      householdId: event.householdId,
      title: payload.title?.trim() ?? event.title,
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

    // Editing an event can change its amount or its linked wallets, so reverse
    // the old event's wallet moves and apply the new one's — together with the
    // row update, in one transaction so they can't diverge. For an asset_sale
    // the sold asset's position must also be reversed then re-applied, so the
    // asset ends up reflecting only the edited sale.
    await this.prisma.runInTransaction(async () => {
      await this.applyWalletEffects(event, 'reverse');
      await this.reverseSaleEffects(event);
      await this.moneyEventsRepository.updateMoneyEvent(eventId, next);
      await this.applyWalletEffects(next, 'apply');
      await this.applySaleEffects(next);
    });
    return toMoneyEventCard(next);
  }

  async deleteMoneyEvent(householdId: string, eventId: string) {
    const event = await this.ensureMoneyEvent(householdId, eventId);
    // Removing an event undoes the money it moved: reverse its wallet effects in
    // the same transaction as the soft-delete. For an asset_sale, also restore
    // the sold asset's position (and reopen it if the sale had closed it).
    await this.prisma.runInTransaction(async () => {
      await this.moneyEventsRepository.deleteMoneyEvent(eventId);
      await this.applyWalletEffects(event, 'reverse');
      await this.reverseSaleEffects(event);
    });
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
    for (const event of events) {
      await this.moneyEventsRepository.deleteMoneyEvent(event.id);
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
    if (debitId) {
      await this.assetsService.debitManualAsset(
        householdId,
        debitId,
        netAmount,
      );
    }
    if (creditId) {
      await this.assetsService.creditManualAsset(
        householdId,
        creditId,
        netAmount,
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
