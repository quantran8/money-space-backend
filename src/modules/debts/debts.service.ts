import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import { AS_OF } from '../../common/seed/money-space.seed';
import { MoneyEventsService } from '../money-events/money-events.service';
import { PaymentsService } from '../payments/payments.service';
import { SnapshotsService } from '../snapshots/snapshots.service';
import type { CreateUpcomingPaymentDto } from '../payments/dto/create-upcoming-payment.dto';
import type { CreateDebtDto } from './dto/create-debt.dto';
import type { ListDebtsQuery } from './dto/list-debts.query';
import type { UpdateDebtDto } from './dto/update-debt.dto';
import { Debt, isFixedScheduleLender } from './entities/debt.entity';
import { DEBTS_REPOSITORY } from './repositories/debts.repository.interface';
import type { DebtsRepository } from './repositories/debts.repository.interface';

/**
 * The subset of a debt-linked money event that `updateDebt`'s mode paths read:
 * `direction`/`amount` to sum recorded repayments, plus `id`/`type`/`isoDate`
 * to find and re-date the borrow inflow when `borrowedAt` moves.
 */
type BorrowEvent = {
  id: string;
  type: string;
  direction: string;
  amount: number;
  isoDate: string;
};

/** Months between two repayments for each recurring `paymentFrequency`. */
const REPAYMENT_STEP_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/**
 * Add `months` to an ISO date (yyyy-mm-dd) and return an ISO date. Clamps to the
 * last day of the target month so e.g. Jan 31 + 1 month → Feb 28/29 rather than
 * rolling into March. Uses UTC to stay independent of the server timezone.
 */
function addMonthsIso(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const base = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0),
  ).getUTCDate();
  base.setUTCDate(Math.min(day, lastDay));
  return base.toISOString().slice(0, 10);
}

@Injectable()
export class DebtsService {
  constructor(
    @Inject(DEBTS_REPOSITORY)
    private readonly debtsRepository: DebtsRepository,
    private readonly prisma: PrismaService,
    private readonly moneyEventsService: MoneyEventsService,
    private readonly paymentsService: PaymentsService,
    private readonly snapshots: SnapshotsService,
  ) {}

  /**
   * Auto-snapshot after a debt write commits: recompute totals (total_debt
   * changed) and refresh the received-to wallet's line if the debt credited one.
   * A `onHouseholdChanged`/`onAssetChanged` here also covers the wallet moves
   * done by the nested `createMoneyEvent` calls, whose own hooks skipped because
   * they ran inside this debt transaction (isInTransaction).
   */
  private async snapshotAfterDebt(
    householdId: string,
    receivedToAssetId?: string | null,
  ): Promise<void> {
    if (receivedToAssetId) {
      await this.snapshots.onAssetChanged(householdId, receivedToAssetId);
    } else {
      await this.snapshots.onHouseholdChanged(householdId);
    }
  }

  async listDebts(householdId: string, query?: ListDebtsQuery) {
    await this.debtsRepository.assertHousehold(householdId);
    let items = await this.debtsRepository.findDebtsByHousehold(householdId);

    if (query?.status) {
      items = items.filter((debt) => debt.status === query.status);
    }
    if (query?.limit) {
      const limit = Number(query.limit);
      if (Number.isFinite(limit) && limit > 0) {
        items = items.slice(0, limit);
      }
    }

    return {
      householdId,
      items,
      total: items.length,
    };
  }

  async getDebt(householdId: string, debtId: string) {
    return this.ensureDebt(householdId, debtId);
  }

  /**
   * A `bank_institution` loan is a fixed-schedule debt: the interest rate, the
   * final due date (its term), and the fixed monthly payment are all required so
   * the repayment schedule and its locked events are well-defined (see
   * memory/debts.md). `relative` / `other` loans leave all three optional. This
   * runs on both create and update so a debt can't be moved into the
   * bank_institution bucket while missing its required terms.
   */
  private assertLenderTerms(debt: Debt): void {
    if (!isFixedScheduleLender(debt.lenderType)) {
      return;
    }
    const missing: string[] = [];
    const hasRate =
      (debt.interestRate ?? 0) > 0 ||
      (debt.interestPeriods?.some((period) => (period.interestRate ?? 0) > 0) ??
        false);
    if (!hasRate) {
      missing.push('interestRate');
    }
    if (!debt.expectedFinalDueDate) {
      missing.push('expectedFinalDueDate');
    }
    if (!debt.fixedPaymentAmount || debt.fixedPaymentAmount <= 0) {
      missing.push('fixedPaymentAmount');
    }
    if (missing.length > 0) {
      throw new BadRequestException(
        `A bank/institution debt requires ${missing.join(', ')}`,
      );
    }
  }

  async createDebt(householdId: string, payload: CreateDebtDto) {
    // `insertDebt` asserts the household exists (and needs its row to resolve
    // `createdById`), so we don't assert it a second time here.
    const debt: Debt = {
      id: this.debtsRepository.createId('debt'),
      householdId,
      name: payload.name.trim(),
      lenderType: payload.lenderType,
      lenderName: payload.lenderName?.trim(),
      originalAmount: payload.originalAmount,
      outstandingAmount: payload.outstandingAmount,
      currency: payload.currency?.trim() || 'VND',
      borrowedAt: payload.borrowedAt,
      expectedFinalDueDate: payload.expectedFinalDueDate,
      status: payload.status ?? 'active',
      ownerMemberId: payload.ownerMemberId,
      receivedToAssetId: payload.receivedToAssetId,
      paymentFrequency: payload.paymentFrequency,
      fixedPaymentAmount: payload.fixedPaymentAmount,
      minimumPaymentAmount: payload.minimumPaymentAmount,
      interestType: payload.interestType,
      interestCalculation: payload.interestCalculation,
      interestRate: payload.interestRate,
      interestPeriods: payload.interestPeriods,
      note: payload.note?.trim(),
    };

    // A bank/institution loan must carry its fixed-schedule terms up front.
    this.assertLenderTerms(debt);

    // All writes for a debt (the debt row + its terms + interest periods, plus
    // crediting the wallet that received the borrowed money) must succeed or
    // fail together, so run them in one transaction. Statements on a single
    // transaction run sequentially — one connection, no concurrent
    // `Promise.all` on the shared `tx`.
    //
    // Raise the interactive-transaction timeout above Prisma's 5s default: this
    // unit does several sequential writes (and the repayment schedule) against a
    // possibly remote/pooled DB, and a slow round-trip must not close the
    // transaction mid-flight ("Transaction not found").
    await this.prisma.runInTransaction(
      async () => {
        await this.debtsRepository.insertDebt(debt);
        await this.debtsRepository.upsertDebtInterestPeriods(debt);
        // Borrowing puts money into the receiving wallet: the asset and the
        // debt rise together, so net worth is unchanged (see memory/debts.md).
        // We log an inflow money event linked to both the wallet and the debt;
        // `createMoneyEvent` credits the `toAsset` wallet itself (wallet assets
        // only), so we must NOT credit it a second time here.
        if (debt.receivedToAssetId) {
          await this.moneyEventsService.createMoneyEvent(householdId, {
            amount: debt.originalAmount,
            note: debt.note
              ? `Vay: ${debt.name} — ${debt.note}`
              : `Vay: ${debt.name}`,
            isoDate: debt.borrowedAt ?? AS_OF,
            type: 'debt_update',
            category: 'debt',
            // `debt_update` defaults to outflow; borrowed money comes IN, so
            // make the inflow explicit (explicit wins in `deriveDirection`).
            direction: 'inflow',
            toAssetId: debt.receivedToAssetId,
            debtId: debt.id,
          });
        }
        // A configured repayment schedule (recurring frequency + a per-period
        // amount) materializes as upcoming-payment records linked to the debt,
        // so the repayments show up in the events timeline as things owed.
        await this.createRepaymentSchedule(householdId, debt);
      },
      { timeout: 15000, maxWait: 10000 },
    );
    await this.snapshotAfterDebt(householdId, debt.receivedToAssetId);
    return debt;
  }

  /**
   * Turn a debt's repayment terms into upcoming-payment records. Runs only when
   * the debt has a recurring `paymentFrequency` (monthly/quarterly/yearly) and a
   * per-period amount (`fixedPaymentAmount`, else `minimumPaymentAmount`).
   *
   * Due dates step from the first period after `borrowedAt` (defaulting to
   * `AS_OF`) by the frequency, and stop at `expectedFinalDueDate` when set —
   * otherwise we cap at `MAX_GENERATED_INSTALLMENTS` so an open-ended debt does
   * not spawn an unbounded number of rows. Meant to run inside the debt-create
   * transaction; each `createUpcomingPayment` joins it.
   */
  private async createRepaymentSchedule(
    householdId: string,
    debt: Debt,
  ): Promise<void> {
    const MAX_GENERATED_INSTALLMENTS = 60;
    const stepMonths = REPAYMENT_STEP_MONTHS[debt.paymentFrequency ?? 'none'];
    const amount = debt.fixedPaymentAmount ?? debt.minimumPaymentAmount;
    if (!stepMonths || !amount || amount <= 0) {
      return;
    }

    const start = debt.borrowedAt ?? AS_OF;
    const finalDue = debt.expectedFinalDueDate;
    const payments: CreateUpcomingPaymentDto[] = [];
    for (let index = 1; index <= MAX_GENERATED_INSTALLMENTS; index += 1) {
      const dueDate = addMonthsIso(start, stepMonths * index);
      if (finalDue && dueDate > finalDue) {
        break;
      }
      payments.push({
        name: `Tra no: ${debt.name}`,
        amount,
        dueDate,
        debtId: debt.id,
        status: 'normal',
      });
      // No explicit end date: generate a single next-due reminder rather than a
      // full open-ended schedule.
      if (!finalDue) {
        break;
      }
    }

    // One bulk insert instead of a round-trip per installment — keeps the
    // debt-create transaction short.
    if (payments.length > 0) {
      await this.paymentsService.createUpcomingPayments(householdId, payments);
    }
  }

  async updateDebt(
    householdId: string,
    debtId: string,
    payload: UpdateDebtDto,
  ) {
    const debt = await this.ensureDebt(householdId, debtId);
    // Merge the incoming fields onto the current debt. `updateMode` is control
    // metadata, not a debt field — omit it so it never lands on the entity.
    const fields: Partial<CreateDebtDto> = { ...payload };
    delete (fields as UpdateDebtDto).updateMode;
    const next: Debt = {
      ...debt,
      ...fields,
      id: debt.id,
      householdId: debt.householdId,
      name: fields.name?.trim() ?? debt.name,
      lenderName: fields.lenderName?.trim() ?? debt.lenderName,
      currency: fields.currency?.trim() ?? debt.currency,
      note: fields.note?.trim() ?? debt.note,
      originalAmount: fields.originalAmount ?? debt.originalAmount,
      outstandingAmount: fields.outstandingAmount ?? debt.outstandingAmount,
      lenderType: fields.lenderType ?? debt.lenderType,
      borrowedAt: fields.borrowedAt ?? debt.borrowedAt,
      expectedFinalDueDate:
        fields.expectedFinalDueDate ?? debt.expectedFinalDueDate,
      status: fields.status ?? debt.status,
    };

    // The updated debt must still satisfy its lender's term requirements — this
    // also guards moving a debt into the bank_institution bucket.
    this.assertLenderTerms(next);

    // A debt with no recorded money events yet keeps the simple direct-overwrite
    // behaviour — nothing to preserve, no mode prompt (see memory/debts.md).
    const events = await this.moneyEventsService.findMoneyEventsByDebt(
      householdId,
      debtId,
    );
    if (events.length === 0) {
      await this.prisma.runInTransaction(async () => {
        await this.debtsRepository.updateDebt(debtId, next);
        await this.debtsRepository.upsertDebtInterestPeriods(next);
      });
      await this.snapshotAfterDebt(householdId, next.receivedToAssetId);
      return next;
    }

    // The debt has history, so the update must say why. An old client that omits
    // `updateMode` must not silently rewrite history.
    const mode = payload.updateMode;
    if (!mode) {
      throw new BadRequestException(
        'updateMode is required when the debt already has payment history',
      );
    }

    let result: Debt;
    if (mode.kind === 'correction') {
      result = await this.applyCorrection(
        householdId,
        debt,
        next,
        payload,
        events,
      );
    } else {
      if (!mode.effectiveDate) {
        throw new BadRequestException(
          'effectiveDate is required for an effective-from-now update',
        );
      }
      result = await this.applyEffective(
        householdId,
        debt,
        next,
        payload,
        mode.effectiveDate,
        mode.balanceIntent,
        events,
      );
    }
    await this.snapshotAfterDebt(householdId, next.receivedToAssetId);
    return result;
  }

  /** Sum of recorded repayments = the debt's outflow money events. */
  private sumRepaidOutflows(events: { direction: string; amount: number }[]) {
    return events
      .filter((event) => event.direction === 'outflow')
      .reduce((sum, event) => sum + event.amount, 0);
  }

  /**
   * Keep the borrow inflow event's date in sync with the debt's `borrowedAt`.
   *
   * `createDebt` logs one `debt_update` **inflow** event ("Vay: …") dated at
   * `borrowedAt`. When an update moves `borrowedAt`, that event — and the wallet
   * valuation point it wrote at the old date — would otherwise be stranded on the
   * original date. Re-date the event via `MoneyEventsService.updateMoneyEvent`,
   * which re-syncs both the event row and its linked valuation point.
   *
   * A debt has at most one borrow inflow (created once, on create). Repayment
   * outflows and reconcile/adjustment neutrals are left untouched. Meant to run
   * inside the caller's `runInTransaction` (the nested update reuses it).
   */
  private async resyncBorrowEventDate(
    householdId: string,
    debt: Debt,
    next: Debt,
    events: BorrowEvent[],
  ): Promise<void> {
    if (!next.borrowedAt || next.borrowedAt === debt.borrowedAt) {
      return;
    }
    const borrowEvent = events.find(
      (event) => event.type === 'debt_update' && event.direction === 'inflow',
    );
    if (!borrowEvent || borrowEvent.isoDate === next.borrowedAt) {
      return;
    }
    await this.moneyEventsService.updateMoneyEvent(
      householdId,
      borrowEvent.id,
      {
        isoDate: next.borrowedAt,
      },
    );
  }

  /** Auditable scalar fields, for before/after diffing in the audit log. */
  private auditSnapshot(debt: Debt) {
    return {
      originalAmount: debt.originalAmount,
      outstandingAmount: debt.outstandingAmount,
      interestRate: debt.interestRate,
      lenderType: debt.lenderType,
      paymentFrequency: debt.paymentFrequency,
      fixedPaymentAmount: debt.fixedPaymentAmount,
      expectedFinalDueDate: debt.expectedFinalDueDate,
    };
  }

  private changedKeys(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): string[] {
    return Object.keys(after).filter((key) => before[key] !== after[key]);
  }

  /**
   * MODE 1 — Correction. The corrected values were "always true": recompute
   * outstanding from the corrected original minus what has been repaid, rewrite
   * the interest schedule wholesale, and leave the recorded repayment events
   * untouched. Writes a `debt.corrected` audit row.
   */
  private async applyCorrection(
    householdId: string,
    debt: Debt,
    next: Debt,
    payload: UpdateDebtDto,
    events: BorrowEvent[],
  ) {
    const correctedOriginal = payload.originalAmount ?? debt.originalAmount;
    const totalRepaid = this.sumRepaidOutflows(events);
    next.outstandingAmount = Math.max(0, correctedOriginal - totalRepaid);

    await this.prisma.runInTransaction(
      async () => {
        await this.debtsRepository.updateDebt(debt.id, next);
        // Delete-all + reinsert = "rewrite the schedule as if always true".
        await this.debtsRepository.upsertDebtInterestPeriods(next);
        // A moved `borrowedAt` must re-date the borrow inflow event too.
        await this.resyncBorrowEventDate(householdId, debt, next, events);
        await this.debtsRepository.writeAuditLog(householdId, {
          action: 'debt.corrected',
          entityType: 'debt',
          entityId: debt.id,
          metadata: {
            mode: 'correction',
            before: this.auditSnapshot(debt),
            after: this.auditSnapshot(next),
            changed: this.changedKeys(
              this.auditSnapshot(debt),
              this.auditSnapshot(next),
            ),
          },
        });
      },
      { timeout: 15000, maxWait: 10000 },
    );
    return next;
  }

  /**
   * MODE 2 — Effective from now. History before `effectiveDate` stays untouched.
   * Each changed field is applied independently:
   * - interest rate change → append a new period from `effectiveDate`.
   * - fixedPaymentAmount change → only future unpaid reminders.
   * - originalAmount change → the 3-way `balanceIntent` (fix / borrow more /
   *   reconcile).
   *
   * Correctness hinge: every money event created here is inflow or neutral, so
   * `createMoneyEvent`'s auto-reduce (debt-linked OUTFLOW only) never fires —
   * we adjust outstanding ourselves. Never make these outflow events.
   */
  private async applyEffective(
    householdId: string,
    debt: Debt,
    next: Debt,
    payload: UpdateDebtDto,
    effectiveDate: string,
    balanceIntent?:
      'fix_original' | 'additional_disbursement' | 'reconcile_balance',
    events: BorrowEvent[] = [],
  ) {
    const originalChanged =
      payload.originalAmount !== undefined &&
      payload.originalAmount !== debt.originalAmount;
    if (originalChanged && !balanceIntent) {
      throw new BadRequestException(
        'balanceIntent is required when originalAmount changes under effective mode',
      );
    }

    // "Fix the original" is a correction regardless of the mode chosen.
    if (originalChanged && balanceIntent === 'fix_original') {
      const events = await this.moneyEventsService.findMoneyEventsByDebt(
        householdId,
        debt.id,
      );
      return this.applyCorrection(householdId, debt, next, payload, events);
    }

    const interestChanged =
      payload.interestRate !== undefined &&
      payload.interestRate !== debt.interestRate;
    const fixedPaymentChanged =
      payload.fixedPaymentAmount !== undefined &&
      payload.fixedPaymentAmount !== debt.fixedPaymentAmount;

    let action = 'debt.updated_effective';
    let loggedEventId: string | undefined;

    await this.prisma.runInTransaction(
      async () => {
        // An additional disbursement raises the total borrowed and what's owed;
        // a reconcile sets outstanding directly. Handle the balance intent
        // before the debt-row write so `next` carries the right amounts.
        if (originalChanged && balanceIntent === 'additional_disbursement') {
          const delta = payload.originalAmount! - debt.originalAmount;
          next.originalAmount = payload.originalAmount!;
          if (debt.receivedToAssetId) {
            const event = await this.moneyEventsService.createMoneyEvent(
              householdId,
              {
                amount: delta,
                note: debt.note
                  ? `Vay thêm: ${debt.name} — ${debt.note}`
                  : `Vay thêm: ${debt.name}`,
                isoDate: effectiveDate,
                type: 'debt_update',
                category: 'debt',
                // Inflow: credits the wallet, does NOT auto-reduce outstanding.
                direction: 'inflow',
                toAssetId: debt.receivedToAssetId,
                debtId: debt.id,
              },
            );
            loggedEventId = event.id;
          }
          // Raise outstanding by the borrowed delta. The inflow event above
          // deliberately does not (it's inflow, and auto-reduce is outflow-only),
          // and `updateDebt(next)` below persists this value — so we set it on
          // `next` rather than issuing a separate UPDATE.
          next.outstandingAmount = debt.outstandingAmount + delta;
          action = 'debt.additional_disbursement';
        } else if (balanceIntent === 'reconcile_balance') {
          // The stated actual balance arrives in `outstandingAmount`.
          const target = payload.outstandingAmount ?? debt.outstandingAmount;
          const delta = target - debt.outstandingAmount;
          next.outstandingAmount = target;
          const event = await this.moneyEventsService.createMoneyEvent(
            householdId,
            {
              amount: Math.abs(delta),
              note: debt.note
                ? `Điều chỉnh dư nợ: ${debt.name} — ${debt.note}`
                : `Điều chỉnh dư nợ: ${debt.name}`,
              isoDate: effectiveDate,
              type: 'adjustment',
              category: 'debt',
              // Neutral: no wallet move, no auto-reduce — a bookkeeping record.
              direction: 'neutral',
              debtId: debt.id,
            },
          );
          loggedEventId = event.id;
          action = 'debt.balance_reconciled';
        }

        await this.debtsRepository.updateDebt(debt.id, next);

        // A moved `borrowedAt` must re-date the original borrow inflow event too
        // (independent of the effective-date changes above, which log their own
        // dated events).
        await this.resyncBorrowEventDate(householdId, debt, next, events);

        // Interest rate change → append a new stage from effectiveDate; the old
        // stages (and their historical rates) are preserved.
        if (interestChanged) {
          await this.debtsRepository.closeLatestInterestPeriodAt(
            debt.id,
            effectiveDate,
          );
          await this.debtsRepository.appendInterestPeriod(
            householdId,
            debt.id,
            {
              startDate: effectiveDate,
              endDate: next.expectedFinalDueDate ?? null,
              interestRate: payload.interestRate!,
            },
          );
        }

        // Repayment-amount change → only the future unpaid reminders.
        if (fixedPaymentChanged) {
          await this.paymentsService.updateUnpaidUpcomingPaymentAmounts(
            householdId,
            debt.id,
            effectiveDate,
            payload.fixedPaymentAmount!,
          );
        }

        await this.debtsRepository.writeAuditLog(householdId, {
          action,
          entityType: 'debt',
          entityId: debt.id,
          metadata: {
            mode: 'effective',
            effectiveDate,
            balanceIntent,
            before: this.auditSnapshot(debt),
            after: this.auditSnapshot(next),
            changed: this.changedKeys(
              this.auditSnapshot(debt),
              this.auditSnapshot(next),
            ),
            loggedEventId,
          },
        });
      },
      { timeout: 15000, maxWait: 10000 },
    );
    return next;
  }

  async deleteDebt(householdId: string, debtId: string) {
    // 404s when the debt (or its household) is absent before we mutate anything.
    const debt = await this.ensureDebt(householdId, debtId);
    // Deleting a debt removes everything the debt created, all in one
    // transaction so they land (or roll back) together, sequentially since they
    // share the transaction's connection:
    //   - the debt row + its terms / interest periods,
    //   - the repayment upcoming-payments generated from its schedule,
    //   - the money events linked to it (the borrow inflow and any repayments),
    //     each of which reverses its own wallet effect as it is deleted (so the
    //     credit the borrow put into the receiving wallet is undone) — keeping
    //     net worth consistent.
    await this.prisma.runInTransaction(
      async () => {
        await this.debtsRepository.deleteDebt(debtId);
        await this.debtsRepository.deleteUpcomingPaymentsByDebt(debtId);
        await this.moneyEventsService.deleteMoneyEventsByDebt(
          householdId,
          debtId,
        );
      },
      // deleteMoneyEventsByDebt reverses each linked event's wallet effects, so
      // this fans out with the number of events. Raise the timeout above the 5s
      // default to avoid aborting mid-write and stranding the connection.
      { timeout: 30000, maxWait: 10000 },
    );
    await this.snapshotAfterDebt(householdId, debt.receivedToAssetId);
    return {
      deleted: true,
      debtId,
    };
  }

  private async ensureDebt(householdId: string, debtId: string) {
    // `findDebtById` filters by { id, householdId, deletedAt: null }, so it
    // already returns undefined when the debt (or its household) is absent —
    // the separate assertHousehold before it was a wasted round-trip.
    const debt = await this.debtsRepository.findDebtById(householdId, debtId);
    if (!debt) {
      throw new NotFoundException(`Debt "${debtId}" was not found`);
    }
    return debt;
  }
}
