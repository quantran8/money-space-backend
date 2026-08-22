import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import {
  FinancialGoal,
  NO_TARGET_DATE,
} from './entities/financial-goal.entity';
import { toGoalCard } from '../../common/utils/money-space.utils';
import { endOfMonthIso, todayInTimeZone } from '../../common/utils/clock';
import {
  projectGoal,
  projectGoalDelayFromSpend,
} from './domain/goal-projection';
import {
  buildConversionCredit,
  buildGoalMonthlyProgress,
} from './domain/goal-monthly-progress';
import { buildGoalProgressChange } from './domain/goal-progress-change';
import { resolveSpendImpact } from './domain/spend-impact';
import {
  resolveContributionProgressAmount,
  resolveGoalCommittedAmount,
  resolveGoalCommittedAmountByGoal,
  resolveGoalCommittedPartsByGoal,
  resolveWalletShareByGoal,
  resolveGoalProgressAmount,
  resolvePlannedMonthlyContribution,
  sumAllocatedAgainstAsset,
  toAllocationInput,
} from './domain/goal-progress';
import type {
  GoalAllocationInput,
  GoalPriority,
  WalletGoalClaim,
} from './domain/goal-progress';
import { PRIORITY_RANK } from './domain/goal-progress';
import { AssetsService } from '../assets/assets.service';
import type {
  GoalAllocationRole,
  GoalAssetAllocation,
} from './entities/financial-goal.entity';
import type {
  CreateGoalAllocationDto,
  UpdateGoalAllocationDto,
} from './dto/goal-allocation.dto';
import type { CreateFinancialGoalDto } from './dto/create-financial-goal.dto';
import type { UpdateFinancialGoalDto } from './dto/update-financial-goal.dto';
import { SNAPSHOTS_REPOSITORY } from '../snapshots/repositories/snapshots.repository.interface';
import type { SnapshotsRepository } from '../snapshots/repositories/snapshots.repository.interface';
import { GOALS_REPOSITORY } from './repositories/goals.repository.interface';
import type { GoalsRepository } from './repositories/goals.repository.interface';
import { CASHFLOW_EVENTS_REPOSITORY } from '../cashflow-events/repositories/cashflow-events.repository.interface';
import type { CashflowEventsRepository } from '../cashflow-events/repositories/cashflow-events.repository.interface';
import { walletValuesAfterPendingOutflows } from './domain/wallet-values-after-pending';
import { LIVE_CASHFLOW_STATUSES } from '../cashflow-events/entities/cashflow-event.entity';

@Injectable()
export class GoalsService {
  constructor(
    @Inject(GOALS_REPOSITORY)
    private readonly goalsRepository: GoalsRepository,
    private readonly prisma: PrismaService,
    private readonly assetsService: AssetsService,
    @Inject(SNAPSHOTS_REPOSITORY)
    private readonly snapshotsRepository: SnapshotsRepository,
    // The repository, not CashflowEventsService: only the plain read is needed,
    // and the service pulls in MoneyEvents/Assets — a far heavier edge for no
    // gain. Cashflow knows nothing about goals, so this direction has no cycle.
    @Inject(CASHFLOW_EVENTS_REPOSITORY)
    private readonly cashflowEventsRepository: CashflowEventsRepository,
  ) {}

  /**
   * Live value per asset id, for resolving goal progress.
   *
   * Reuses `getActiveAssetRecords` — the same valuation engine the snapshot and
   * the dashboard read — so a goal can never disagree with net worth about what
   * an asset is worth. A sold/closed asset is absent from the map and therefore
   * contributes 0, which is right: it is no longer money the household holds.
   */
  private async assetValueMap(
    householdId: string,
  ): Promise<ReadonlyMap<string, number>> {
    return (await this.assetIndex(householdId)).values;
  }

  /**
   * Values AND types from one read of the valuation engine.
   *
   * Every write path needs both — the value to check a claim against, the type
   * to apply the wallet rules — and they must describe the same moment. Two
   * separate reads also meant valuing every asset twice per request.
   */
  private async assetIndex(householdId: string): Promise<{
    values: ReadonlyMap<string, number>;
    types: ReadonlyMap<string, string>;
  }> {
    const assets = await this.assetsService.getActiveAssetRecords(householdId);
    return {
      values: new Map(
        assets.map((asset) => [asset.id, asset.currentValue ?? 0]),
      ),
      types: new Map(assets.map((asset) => [asset.id, asset.type as string])),
    };
  }

  /**
   * How much of the given liquid money the household's goals already claim.
   *
   * Feeds the dashboard's "đã có nhiệm vụ", which used to mean near-term
   * obligations alone — so money explicitly promised to a goal still counted as
   * flexible, and a household with 20tr of a 22tr wallet behind the car was told
   * it had 22tr free.
   *
   * `assetValues` is the caller's liquidity filter: pass only what the figure is
   * being taken out of. Gold behind a goal is not liquid money already
   * committed, because it was never in the liquid total.
   *
   * The two halves — money set aside, and this month's pace out of what is left
   * — cannot overlap; see `resolveGoalCommittedAmount`.
   */
  async resolveGoalCommitments(
    householdId: string,
    assetValues: ReadonlyMap<string, number>,
    /** What percent claims are a percentage OF. See `allocationValue`. */
    percentBasis?: ReadonlyMap<string, number>,
  ): Promise<number> {
    const [goals, allocations] = await Promise.all([
      this.goalsRepository.findFinancialGoalsByHousehold(householdId),
      this.goalsRepository.findAllocationsByHousehold(householdId),
    ]);
    return resolveGoalCommittedAmount(
      goals.map((goal) => ({
        goalId: goal.id,
        priority: goal.priority,
        allocations: allocations
          .filter((allocation) => allocation.financialGoalId === goal.id)
          .map(toAllocationInput),
      })),
      assetValues,
      percentBasis,
    );
  }

  /**
   * Which goals one ASSET is backing, and how much of it is still free.
   *
   * The mirror image of a goal's allocation panel, for the asset detail page.
   * Until now the relationship was only visible from the goal's side: opening an
   * account showed a balance with no hint that most of it was already promised,
   * and the household had to open every goal in turn to find out.
   *
   * Every role is included, not just `contribution`: gold behind a goal is
   * spoken for just as much as a wallet is, and the asset page is where someone
   * asks "can I use this?".
   *
   * `freeAmount` is the same subtraction the write path enforces
   * (`sumAllocatedAgainstAsset`), so what this page reports as free is exactly
   * what a new claim would be allowed to take.
   */
  async assetGoalUsage(householdId: string, assetId: string) {
    await this.goalsRepository.assertHousehold(householdId);
    const [goals, allocations, assetValues] = await Promise.all([
      this.goalsRepository.findFinancialGoalsByHousehold(householdId),
      this.goalsRepository.findAllocationsByHousehold(householdId),
      this.assetValueMap(householdId),
    ]);

    const assetValue = assetValues.get(assetId) ?? 0;
    const byGoal = new Map(goals.map((goal) => [goal.id, goal]));
    const onAsset = allocations.filter(
      (allocation) => allocation.assetId === assetId,
    );

    const items = onAsset.flatMap((allocation) => {
      const goal = byGoal.get(allocation.financialGoalId);
      // A goal that was deleted leaves no claim to report; its allocations went
      // with it. Skipped rather than shown nameless.
      if (!goal) {
        return [];
      }
      return [
        {
          goalId: goal.id,
          goalName: goal.name,
          priority: goal.priority,
          allocationId: allocation.id,
          kind: allocation.kind,
          role: allocation.role,
          allocatedAmount: allocation.allocatedAmount,
          percent: allocation.percent,
          monthlyContribution: allocation.monthlyContribution,
          sharePercent: allocation.sharePercent,
          /** What this claim is worth right now, capped at the asset's value. */
          currentValue: resolveGoalProgressAmount(
            [toAllocationInput(allocation)],
            assetValues,
          ),
        },
      ];
    });

    const claimed = sumAllocatedAgainstAsset(
      onAsset.map(toAllocationInput),
      assetId,
      assetValue,
    );

    /**
     * What the goals claim of this wallet ALL IN — money set aside plus what
     * this month's pace can still draw from the room left over.
     *
     * Distinct from `claimedAmount`, and the distinction matters because the
     * two answer different questions:
     *
     *  - `claimedAmount` / `freeAmount` answer **"how much may a new allocation
     *    still take?"** — the write path's question. A monthly pace does not
     *    lock money away from a new claim, so it is rightly excluded there.
     *  - `committedAmount` / `unassignedAmount` answer **"how much of this
     *    wallet has no job yet?"** — what the asset page and the spend warning
     *    ask, and what the dashboard's "đã có nhiệm vụ" already counts.
     *
     * Reporting the write-path figure under the second question read as a
     * contradiction: a 52tr wallet with 20tr set aside and two goals each
     * promising 20tr/month showed "32tr chưa dành cho mục tiêu nào" while the
     * dashboard counted the whole 52tr as committed. Both goals' paces were
     * drawing on that 32tr; none of it was unassigned.
     *
     * Same resolver as the dashboard (`resolveGoalCommittedAmount`), so the two
     * screens cannot disagree about the same wallet.
     */
    const committedByGoal = resolveGoalCommittedAmountByGoal(
      goals.map((goal) => ({
        goalId: goal.id,
        priority: goal.priority,
        allocations: allocations
          .filter((allocation) => allocation.financialGoalId === goal.id)
          .map(toAllocationInput),
      })),
      new Map([[assetId, assetValue]]),
    );
    const committed = [...committedByGoal.values()].reduce(
      (sum, value) => sum + value,
      0,
    );

    return {
      householdId,
      assetId,
      assetValue,
      claimedAmount: claimed,
      freeAmount: Math.max(0, assetValue - claimed),
      committedAmount: Math.min(committed, assetValue),
      unassignedAmount: Math.max(0, assetValue - committed),
      items: items.map((item) => ({
        ...item,
        /**
         * What this goal is counted as holding from the asset ALL IN — set
         * aside plus its share of this month's pace.
         *
         * `currentValue` is the set-aside part alone, which read as a plain
         * contradiction in the table: a goal promising 20tr/month against a
         * wallet with room for it showed "0đ đang tính" while the dashboard
         * counted 16tr of that wallet behind it.
         */
        countedValue: committedByGoal.get(item.goalId) ?? item.currentValue,
      })),
      total: items.length,
    };
  }

  /**
   * How much of EACH wallet the goals already claim.
   *
   * What-if needs it to decide which wallet a nameless spend would come out of:
   * least-promised money first, which is both what most people would reach for
   * and the order that does not overstate what a purchase costs.
   */
  async goalClaimsByWallet(
    householdId: string,
    assetValues: ReadonlyMap<string, number>,
  ): Promise<Map<string, WalletGoalClaim>> {
    const [goals, allocations] = await Promise.all([
      this.goalsRepository.findFinancialGoalsByHousehold(householdId),
      this.goalsRepository.findAllocationsByHousehold(householdId),
    ]);
    const claims = goals.map((goal) => ({
      goalId: goal.id,
      priority: goal.priority,
      allocations: allocations
        .filter((allocation) => allocation.financialGoalId === goal.id)
        .map(toAllocationInput),
    }));

    // One wallet at a time: a goal's claim on wallet A tells us nothing about
    // how much of wallet B is spoken for, and the ordering question is per
    // wallet.
    const byWallet = new Map<string, WalletGoalClaim>();
    for (const [assetId, value] of assetValues) {
      /**
       * The most important goal this wallet backs.
       *
       * `high` beats `medium` beats `low`, and a wallet backing several goals
       * takes the highest — spending from it puts THAT goal at risk, and the
       * household's own ranking is the only stake worth ordering by. Amount
       * cannot substitute: 1tr promised to the emergency fund outranks 50tr
       * towards a someday holiday, and the household said so.
       */
      let topPriority: GoalPriority | null = null;
      for (const claim of claims) {
        const backsThisWallet = claim.allocations.some(
          (allocation) => allocation.assetId === assetId,
        );
        if (!backsThisWallet) continue;
        if (
          topPriority === null ||
          PRIORITY_RANK[claim.priority] < PRIORITY_RANK[topPriority]
        ) {
          topPriority = claim.priority;
        }
      }

      byWallet.set(assetId, {
        amount: Math.min(
          value,
          resolveGoalCommittedAmount(claims, new Map([[assetId, value]])),
        ),
        topPriority,
      });
    }
    return byWallet;
  }

  /**
   * What a spend costs EVERY goal, across every wallet at once.
   *
   * The what-if form of `spendImpact`. What-if asks a household-level question —
   * "what if we spent this" — not a per-wallet one, so it must not force the
   * household to nominate a wallet before it will answer. It passes the
   * before/after wallet values the forecast already produced (the after side has
   * the spend taken out, per `walletValuesAfterOutflows`), and this reports what
   * moved.
   *
   * Same resolver as everywhere else, so a what-if and the event it becomes can
   * never report different costs for the same spend.
   */
  async spendImpactAcrossWallets(
    householdId: string,
    before: ReadonlyMap<string, number>,
    after: ReadonlyMap<string, number>,
  ) {
    const [goals, allocations] = await Promise.all([
      this.goalsRepository.findFinancialGoalsByHousehold(householdId),
      this.goalsRepository.findAllocationsByHousehold(householdId),
    ]);
    const claims = goals.map((goal) => ({
      goalId: goal.id,
      priority: goal.priority,
      allocations: allocations
        .filter((allocation) => allocation.financialGoalId === goal.id)
        .map(toAllocationInput),
    }));

    const partsBefore = resolveGoalCommittedPartsByGoal(claims, before);
    const partsAfter = resolveGoalCommittedPartsByGoal(claims, after);
    const today = todayInTimeZone();

    const items = goals.flatMap((goal) => {
      const b = partsBefore.get(goal.id) ?? { setAside: 0, pace: 0 };
      const a = partsAfter.get(goal.id) ?? { setAside: 0, pace: 0 };
      const beforeValue = b.setAside + b.pace;
      const afterValue = a.setAside + a.pace;
      const reduction = Math.max(0, beforeValue - afterValue);
      if (reduction <= 0) {
        return [];
      }

      const cost = {
        paceReduction: Math.max(0, b.pace - a.pace),
        setAsideReduction: Math.max(0, b.setAside - a.setAside),
      };
      const delay = projectGoalDelayFromSpend(
        {
          goalId: goal.id,
          targetAmount: Number(goal.targetAmount ?? 0),
          currentAmount: beforeValue,
          plannedMonthlyContribution: goal.plannedMonthlyContribution ?? null,
          targetDate:
            goal.targetDate && goal.targetDate !== 'No deadline'
              ? goal.targetDate
              : null,
          status: 'active' as const,
          asOfDate: today,
        },
        cost,
      );

      return [
        {
          goalId: goal.id,
          goalName: goal.name,
          before: beforeValue,
          after: afterValue,
          reduction,
          ...cost,
          delayMonths: delay.delayMonths,
          delayDays: delay.delayDays,
          completionDateBefore: delay.before.projectedCompletionDate,
          completionDateAfter: delay.after.projectedCompletionDate,
        },
      ];
    });

    // Biggest loser first: the goal paying most is the one to read first.
    items.sort((left, right) => right.reduction - left.reduction);

    return {
      totalReduction: items.reduce((sum, item) => sum + item.reduction, 0),
      totalPaceReduction: items.reduce(
        (sum, item) => sum + item.paceReduction,
        0,
      ),
      totalSetAsideReduction: items.reduce(
        (sum, item) => sum + item.setAsideReduction,
        0,
      ),
      goals: items,
    };
  }

  /**
   * What spending `amount` from `assetId` would cost the goals saving into it.
   *
   * Read-only, and meant to be called while the household is still typing: the
   * cashflow form shows this before the outflow is saved. An outflow outranks
   * the goals sharing its wallet, so scheduling one silently shrinks the money
   * those goals hold — and a goal losing 3tr without anyone being told is the
   * silent erosion this endpoint exists to prevent.
   *
   * Goal names are resolved here so the caller can render a sentence without a
   * second round trip.
   */
  async spendImpact(householdId: string, assetId: string, amount: number) {
    await this.goalsRepository.assertHousehold(householdId);
    const [goals, allocations, assetValues] = await Promise.all([
      this.goalsRepository.findFinancialGoalsByHousehold(householdId),
      this.goalsRepository.findAllocationsByHousehold(householdId),
      this.assetValueMap(householdId),
    ]);

    const impact = resolveSpendImpact(
      goals.map((goal) => ({
        goalId: goal.id,
        priority: goal.priority,
        allocations: allocations
          .filter((allocation) => allocation.financialGoalId === goal.id)
          .map(toAllocationInput),
      })),
      assetId,
      assetValues.get(assetId) ?? 0,
      amount,
    );

    const byId = new Map(goals.map((goal) => [goal.id, goal]));
    const today = todayInTimeZone();

    return {
      householdId,
      ...impact,
      goals: impact.goals.map((goal) => {
        const record = byId.get(goal.goalId);

        /**
         * The TIME cost, alongside the money.
         *
         * "Mục tiêu giảm 3tr" says what leaves; "về đích chậm 2 tháng" says what
         * it costs, and the second is what decides whether a purchase is worth
         * it. Resolved per goal from the same split the money figures come from,
         * so the two can never describe different spends.
         *
         * `null` when the goal declared no monthly pace — without a rate there
         * is no honest way to turn money into time.
         */
        const delay = record
          ? projectGoalDelayFromSpend(
              {
                goalId: record.id,
                targetAmount: Number(record.targetAmount ?? 0),
                currentAmount: goal.before,
                plannedMonthlyContribution:
                  record.plannedMonthlyContribution ?? null,
                targetDate:
                  record.targetDate && record.targetDate !== 'No deadline'
                    ? record.targetDate
                    : null,
                status: 'active' as const,
                asOfDate: today,
              },
              goal,
            )
          : null;

        return {
          ...goal,
          goalName: record?.name ?? null,
          delayMonths: delay?.delayMonths ?? null,
          delayDays: delay?.delayDays ?? null,
          /** When the goal was on track to land, and when it lands now. */
          completionDateBefore: delay?.before.projectedCompletionDate ?? null,
          completionDateAfter: delay?.after.projectedCompletionDate ?? null,
        };
      }),
    };
  }

  /**
   * The money actually behind one goal.
   *
   * Public because ForecastService needs it for the what-if goal impact.
   * Forecast's own `assets` list carries only liquid sources, so it cannot
   * resolve this itself — a goal backed by gold or crypto would come out as 0
   * there.
   */
  async resolveProgressAmount(
    householdId: string,
    goal: FinancialGoal,
  ): Promise<number> {
    const [allocations, assetValues] = await Promise.all([
      this.goalsRepository.findAllocationsByGoal(householdId, goal.id),
      this.assetValueMap(householdId),
    ]);
    return this.progressFor(goal, allocations, assetValues);
  }

  /**
   * The goal's progress figure. `allocations` is the household's full set; the
   * goal's own rows are filtered here so callers can fetch once and resolve
   * many goals.
   */
  private progressFor(
    goal: FinancialGoal,
    allocations: GoalAssetAllocation[],
    assetValues: ReadonlyMap<string, number>,
  ): number {
    return resolveGoalProgressAmount(
      allocations
        .filter((allocation) => allocation.financialGoalId === goal.id)
        .map(toAllocationInput),
      assetValues,
    );
  }

  /**
   * `?include=projection` attaches each goal's projection (§26C) to the list.
   *
   * Opt-in rather than always-on: the Goals screen needs it, the goal picker in
   * a form does not, and projecting N goals the caller will not render is work
   * nobody asked for.
   *
   * The projection is computed HERE, from the pure `projectGoal` in this
   * module's own `domain/`, rather than by calling ForecastService — Forecast
   * imports Goals, so the reverse edge would be a cycle.
   */
  async listFinancialGoals(householdId: string, include?: string) {
    // No `assertHousehold`: `HouseholdAccessGuard` already validated the
    // household + membership for this route, so a second lookup of the same
    // row buys nothing but a query.
    const [goals, allocations, assetValues] = await Promise.all([
      this.goalsRepository.findFinancialGoalsByHousehold(householdId),
      this.goalsRepository.findAllocationsByHousehold(householdId),
      this.assetValueMap(householdId),
    ]);

    const parts = (include ?? '').split(',').map((part) => part.trim());
    const wantsProjection = parts.includes('projection');
    const wantsWalletUsage = parts.includes('walletUsage');
    const asOfDate = todayInTimeZone();

    const items = goals.map((goal) => {
      const progressAmount = this.progressFor(goal, allocations, assetValues);
      return {
        ...toGoalCard(goal, progressAmount),
        ...(wantsProjection
          ? { projection: this.projectionFor(goal, asOfDate, progressAmount) }
          : {}),
      };
    });

    return {
      householdId,
      items,
      total: items.length,
      ...(wantsWalletUsage
        ? { walletUsage: this.walletUsage(goals, allocations, assetValues) }
        : {}),
    };
  }

  /**
   * Which goals already draw on each wallet, so the create form can ask for a
   * share BEFORE the household runs short rather than after.
   *
   * A wallet feeding one goal has nothing to divide; the question only arises
   * once a second goal at the same priority joins it. The form cannot know that
   * on its own — it holds one goal and no view of the others — so the answer
   * ships with the goals list, from data already loaded to compute progress.
   */
  private walletUsage(
    goals: FinancialGoal[],
    allocations: GoalAssetAllocation[],
    assetValues: ReadonlyMap<string, number>,
  ) {
    const byGoal = new Map(goals.map((goal) => [goal.id, goal]));
    const wallets = new Map<
      string,
      Array<{
        goalId: string;
        name: string;
        priority: GoalPriority;
        monthlyContribution: number | null;
        sharePercent: number | null;
      }>
    >();

    for (const allocation of allocations) {
      if (allocation.role !== 'contribution') {
        continue;
      }
      const goal = byGoal.get(allocation.financialGoalId);
      if (!goal) {
        continue;
      }
      const rows = wallets.get(allocation.assetId) ?? [];
      rows.push({
        goalId: goal.id,
        name: goal.name,
        priority: goal.priority,
        monthlyContribution: allocation.monthlyContribution,
        sharePercent: allocation.sharePercent,
      });
      wallets.set(allocation.assetId, rows);
    }

    return [...wallets.entries()].map(([assetId, rows]) => {
      const assetValue = assetValues.get(assetId) ?? 0;
      return {
        assetId,
        // What is left after every claim on this wallet — the room the goals
        // are actually competing for.
        freeAmount: Math.max(
          0,
          assetValue -
            sumAllocatedAgainstAsset(
              allocations.map(toAllocationInput),
              assetId,
              assetValue,
            ),
        ),
        goals: rows,
      };
    });
  }

  async getFinancialGoal(householdId: string, goalId: string) {
    const goal = await this.ensureFinancialGoal(householdId, goalId);
    const [allocations, assetValues] = await Promise.all([
      this.goalsRepository.findAllocationsByGoal(householdId, goalId),
      this.assetValueMap(householdId),
    ]);
    const progressAmount = this.progressFor(goal, allocations, assetValues);
    return {
      ...toGoalCard(goal, progressAmount),
      projection: this.projectionFor(goal, todayInTimeZone(), progressAmount),
      allocations: allocations.map((allocation) =>
        toAllocationCard(allocation, assetValues),
      ),
    };
  }

  /**
   * One goal's projection, shaped for `projectGoal`.
   *
   * `progressAmount` is passed in already resolved from the goal's allocations
   * — a goal stores no figure of its own.
   */
  private projectionFor(
    goal: FinancialGoal,
    asOfDate: string,
    progressAmount: number,
  ) {
    return projectGoal({
      goalId: goal.id,
      targetAmount: goal.targetAmount,
      currentAmount: progressAmount,
      plannedMonthlyContribution: goal.plannedMonthlyContribution,
      // `NO_TARGET_DATE` is a wire sentinel, not a date. Passing it straight
      // through would make every undated goal look like it was due on the
      // string "No deadline".
      targetDate:
        goal.targetDate && goal.targetDate !== NO_TARGET_DATE
          ? goal.targetDate
          : null,
      status: 'active',
      asOfDate,
    });
  }

  /**
   * Create a goal together with the assets that back it, in one transaction.
   *
   * At least one allocation is REQUIRED. A goal is a set of shares of real
   * assets; one with no shares has no progress and no way to gain any, so
   * creating it would leave a permanent 0% and a household wondering what to do
   * next. Asking here — where the household is already thinking about the goal
   * — is what makes "which money is this?" a question they answer once.
   *
   * Every claim is checked against what its asset still has free, exactly as an
   * allocation added later would be, so the same money cannot be promised to
   * two goals just because one of them was created in a single call.
   */
  async createFinancialGoal(
    householdId: string,
    payload: CreateFinancialGoalDto,
  ) {
    // `insertFinancialGoal` asserts the household exists (and needs its row to
    // resolve `createdById`), so we don't assert it a second time here.
    const allocations = payload.allocations ?? [];
    if (allocations.length === 0) {
      throw new BadRequestException(
        'A goal needs at least one asset behind it. Choose which money counts towards it — a savings account, cash, gold, anything the household already holds.',
      );
    }

    const goalId = this.goalsRepository.createId('goal');

    // Validate the whole set BEFORE writing anything: a goal that lands with
    // half its assets is worse than one that does not land at all.
    // The household's goals come along for the share check: a wallet's monthly
    // room is only divided between goals at the SAME priority, which lives on
    // the goal rather than the allocation.
    const [existing, assets, existingGoals] = await Promise.all([
      this.goalsRepository.findAllocationsByHousehold(householdId),
      this.assetIndex(householdId),
      this.goalsRepository.findFinancialGoalsByHousehold(householdId),
    ]);
    const assetValues = assets.values;
    const seenAssets = new Set<string>();
    const rows: GoalAssetAllocation[] = [];
    // Claims made in THIS call must be counted against each other too, or two
    // rows in one payload could together exceed the asset.
    const pending: GoalAllocationInput[] = [];

    for (const entry of allocations) {
      if (!entry.assetId) {
        throw new BadRequestException('assetId is required');
      }
      if (seenAssets.has(entry.assetId)) {
        throw new BadRequestException(
          'Each asset can only count towards this goal once. Combine the two shares into one.',
        );
      }
      seenAssets.add(entry.assetId);

      const assetValue = assetValues.get(entry.assetId);
      const assetType = assets.types.get(entry.assetId);
      if (assetValue === undefined || assetType === undefined) {
        throw new NotFoundException(`Asset "${entry.assetId}" was not found`);
      }
      const shape = normalizeAllocationShape(entry.kind, entry);
      this.assertWithinAssetValue(
        existing,
        entry.assetId,
        assetValue,
        shape,
        undefined,
        pending,
      );
      pending.push({ assetId: entry.assetId, ...shape });

      const role = entry.role ?? defaultRoleForType(assetType);
      this.assertShareWithinWallet(
        existing,
        existingGoals,
        entry.assetId,
        payload.priority,
        normalizeSharePercent(entry.sharePercent ?? null, assetType, role),
      );
      rows.push({
        id: this.goalsRepository.createId('goal-allocation'),
        householdId,
        financialGoalId: goalId,
        assetId: entry.assetId,
        kind: shape.kind,
        role,
        monthlyContribution: normalizeMonthlyContribution(
          entry.monthlyContribution ?? null,
          assetType,
          role,
        ),
        sharePercent: normalizeSharePercent(
          entry.sharePercent ?? null,
          assetType,
          role,
        ),
        allocatedAmount: shape.allocatedAmount,
        percent: shape.percent,
        note: entry.note?.trim() ?? '',
      });
    }

    // A goal with no wallet behind it USED to be refused here: money is only put
    // into a goal through one, so such a goal has nothing to be saved into and
    // its pace panel can only stay empty.
    //
    // That is still true, and it is still worth telling the household — but it
    // is no longer worth REFUSING, because the state turned out to be reachable
    // without anyone choosing it. Deleting an asset can take a goal's last
    // wallet with it, and a rule enforced only at create time would leave goals
    // that exist but cannot be edited back into legality. A goal is now allowed
    // to be in this state, and `goal_without_wallet` (a derived attention
    // signal, recomputed on every read) is what tells the household about it —
    // one place, whether the goal got there by being created that way or by
    // outliving its wallet.
    //
    // "At least one allocation of ANY kind" is still required, above: a goal
    // with no assets at all has no progress and no way to gain any.

    const goal: FinancialGoal = {
      id: goalId,
      householdId,
      name: payload.name.trim(),
      targetAmount: payload.targetAmount,
      // Never taken from the payload: the pace is what the wallet shares say it
      // is, and this column is their sum.
      plannedMonthlyContribution: resolvePlannedMonthlyContribution(
        rows.map(toAllocationInput),
      ),
      // What the household said was ALREADY set aside, frozen now because it
      // stops being recoverable the moment the first contribution lands: after
      // that, the allocation's amount is opening balance and new money mixed
      // together. Without it the first month has nothing to subtract from and
      // reports "—" for a figure the household did state on this very form.
      baselineContributionAmount: resolveContributionProgressAmount(
        rows.map(toAllocationInput),
        assetValues,
      ),
      priority: payload.priority,
      note: payload.note?.trim() ?? '',
      targetDate: payload.targetDate ?? NO_TARGET_DATE,
    };

    await this.prisma.runInTransaction(async () => {
      await this.goalsRepository.insertFinancialGoal(goal);
      for (const row of rows) {
        await this.goalsRepository.insertAllocation(row);
      }
    });

    const progressAmount = resolveGoalProgressAmount(
      rows.map(toAllocationInput),
      assetValues,
    );
    return {
      ...toGoalCard(goal, progressAmount),
      allocations: rows.map((row) => toAllocationCard(row, assetValues)),
    };
  }

  async updateFinancialGoal(
    householdId: string,
    goalId: string,
    payload: UpdateFinancialGoalDto,
  ) {
    const goal = await this.ensureFinancialGoal(householdId, goalId);
    const next: FinancialGoal = {
      ...goal,
      ...payload,
      id: goal.id,
      householdId: goal.householdId,
      name: payload.name?.trim() ?? goal.name,
      targetAmount: payload.targetAmount ?? goal.targetAmount,
      // Held at its stored value whatever the body carries. The pace is edited
      // on the wallet shares (`…/allocations`), and letting a goal PATCH set it
      // would put a figure here that no allocation underneath it claims — the
      // exact drift a mirror column exists to avoid.
      plannedMonthlyContribution: goal.plannedMonthlyContribution,
      note: payload.note?.trim() ?? goal.note,
      targetDate: payload.targetDate ?? goal.targetDate,
      priority: payload.priority ?? goal.priority,
    };

    await this.goalsRepository.updateFinancialGoal(goalId, next);
    return toGoalCard(next);
  }

  async deleteFinancialGoal(householdId: string, goalId: string) {
    await this.ensureFinancialGoal(householdId, goalId);
    // The soft-delete, the money-event unlink and the allocation removal must
    // land together — a surviving allocation would point at a deleted goal.
    await this.prisma.runInTransaction(async () => {
      await this.goalsRepository.deleteFinancialGoal(goalId);
      await this.goalsRepository.unlinkFinancialGoalFromMoneyEvents(
        householdId,
        goalId,
      );
      await this.goalsRepository.deleteAllocationsByGoal(householdId, goalId);
    });
    return {
      deleted: true,
      goalId,
    };
  }

  /**
   * Month by month: how much went into this goal, against the pace the
   * household declared.
   *
   * The figures come from the progress frozen into each snapshot, so a month's
   * delta already accounts for everything that moved the goal — money added to
   * a backing asset, money spent out of one, and the asset repricing. That is
   * the whole point: "we meant to set aside 10tr, we managed 8tr because we
   * spent 2tr" is one subtraction, not a separate ledger.
   */
  async monthlyProgress(householdId: string, goalId: string) {
    const goal = await this.ensureFinancialGoal(householdId, goalId);
    // Live progress joins the frozen history as one more point, dated today, so
    // the month still running gets a row instead of appearing only once it
    // closes. Mid-month a household would otherwise see its 10tr target and no
    // indication of where it stands — the feedback the removed "contribute"
    // button used to provide.
    // The household's OTHER goals are needed too — with their priorities. Goals
    // sharing a wallet compete for one balance, and the order they are served in
    // is `priority`, so the running month's estimate can only be computed for
    // all of them at once.
    const [
      points,
      allocations,
      liveAssetValues,
      householdAllocations,
      householdGoals,
      cashflowEvents,
    ] = await Promise.all([
      this.snapshotsRepository.findGoalProgressPoints(householdId, goalId),
      this.goalsRepository.findAllocationsByGoal(householdId, goalId),
      this.assetValueMap(householdId),
      this.goalsRepository.findAllocationsByHousehold(householdId),
      this.goalsRepository.findFinancialGoalsByHousehold(householdId),
      this.cashflowEventsRepository.findCashflowEventsByHousehold(householdId),
    ]);

    /**
     * Measured against the wallet AS IT STANDS, scheduled outflows left in.
     * Money that has not moved has not been spent, and a bill can still be
     * cancelled. What those outflows will cost is answered in one place —
     * `scheduledOutflowImpact` — rather than folded in here.
     */
    const today = todayInTimeZone();

    const inputs = allocations.map(toAllocationInput);
    const claims = householdGoals.map((item) => ({
      goalId: item.id,
      priority: item.priority,
      allocations: householdAllocations
        .filter((allocation) => allocation.financialGoalId === item.id)
        .map(toAllocationInput),
    }));
    // Percent claims stay a percentage of the wallet BEFORE any outflow, for the
    // reason `allocationValue` documents: "90% of this wallet" is a standing
    // arrangement, and re-reading it against a lowered value would shave every
    // goal even when the bill fits inside unassigned money.
    const walletShares = resolveWalletShareByGoal(claims, liveAssetValues);
    const share = walletShares.get(goalId);
    const conversions = await this.goalsRepository.findGoalConversionPurchases(
      householdId,
      allocations.map((allocation) => allocation.assetId),
    );

    return {
      householdId,
      goalId,
      plannedMonthlyContribution: goal.plannedMonthlyContribution,
      months: buildGoalMonthlyProgress(
        points,
        goal.plannedMonthlyContribution,
        {
          current: {
            date: today,
            // Actual: the wallet as it stands, outflows still in it.
            progressAmount: resolveGoalProgressAmount(inputs, liveAssetValues),
            contributionAmount: resolveContributionProgressAmount(
              inputs,
              liveAssetValues,
            ),
          },
          hasContributionSource: inputs.some(
            (input) => input.role === 'contribution',
          ),
          conversionCreditByMonth: buildConversionCredit(conversions),
          baselineContribution: goal.baselineContributionAmount,
          // Null when this goal has no contribution wallet at all: nothing to
          // estimate, which the panel reads as "no target" rather than as a
          // month missed.
          monthlyHeadroom: inputs.some(
            (input) =>
              input.role === 'contribution' &&
              input.monthlyContribution != null &&
              input.monthlyContribution > 0,
          )
            ? (share?.amount ?? 0)
            : null,
        },
      ),
      // True when a wallet had to be split without the household having said
      // how. The figure stands, but it was the product's fallback, not their
      // decision — the UI asks rather than presenting it as settled.
      needsShareDecision: share?.needsShareDecision ?? false,
    };
  }

  /**
   * Why the goal's figure moved since the last frozen point.
   *
   * A goal backed by gold reprices on its own, and a household that saw 50%
   * yesterday and 48% today changed nothing. Freezing the asset at its assigned
   * value would "fix" that by lying — the goal would claim 250tr of gold that
   * would fetch 240tr. So the figure keeps following the assets and this says
   * which one moved.
   */
  async progressChange(householdId: string, goalId: string) {
    const goal = await this.ensureFinancialGoal(householdId, goalId);
    const today = todayInTimeZone();
    const [basis, allocations, assetValues, assetNames] = await Promise.all([
      this.snapshotsRepository.findGoalProgressChangeBasis(
        householdId,
        goalId,
        today,
      ),
      this.goalsRepository.findAllocationsByGoal(householdId, goalId),
      this.assetValueMap(householdId),
      this.assetNameMap(householdId),
    ]);

    const inputs = allocations.map(toAllocationInput);
    const currentAmount = resolveGoalProgressAmount(inputs, assetValues);

    // Compare each allocation's WORTH, not the asset's raw value: a goal
    // claiming half a position only felt half of that position's move.
    const currentLines = inputs.map((input) => ({
      assetId: input.assetId,
      assetName: assetNames.get(input.assetId) ?? '',
      value: resolveGoalProgressAmount([input], assetValues),
    }));
    const previousLines = basis
      ? inputs.map((input) => {
          const frozen = new Map(
            basis.assets.map((line) => [line.assetId, line.value]),
          );
          return {
            assetId: input.assetId,
            assetName: assetNames.get(input.assetId) ?? '',
            value: resolveGoalProgressAmount([input], frozen),
          };
        })
      : [];

    return {
      householdId,
      goalId,
      change: buildGoalProgressChange(
        basis?.date ?? null,
        basis?.progressAmount ?? null,
        currentAmount,
        previousLines,
        currentLines,
      ),
    };
  }

  /** Asset id → display name, for explaining what moved. */
  private async assetNameMap(
    householdId: string,
  ): Promise<ReadonlyMap<string, string>> {
    const assets = await this.assetsService.getActiveAssetRecords(householdId);
    return new Map(assets.map((asset) => [asset.id, asset.name]));
  }

  /**
   * Everything this goal loses to money already scheduled to leave its wallets.
   *
   * ## Why it is ONE endpoint rather than a field on several
   *
   * The figures a scheduled outflow moves are spread across the goal screen —
   * the total held, the month's pace, each affected wallet. Answering "what does
   * this bill cost me" by hanging a projected number off each of them fragments
   * one fact into four, repeats it without ever explaining it, and leaves the
   * household to reassemble the story. Worse, the cause (a named bill, on a
   * date) has nowhere to live.
   *
   * So the whole picture is assembled here and rendered as a single section: the
   * events by name and date, and what they leave behind. The figures elsewhere
   * on the screen stay untouched — actual, as `wallet-values-after-pending`
   * describes — and this is the one place that says what is coming.
   *
   * `null` when nothing is scheduled that touches this goal's wallets, so the
   * section simply does not render.
   */
  async scheduledOutflowImpact(householdId: string, goalId: string) {
    const goal = await this.ensureFinancialGoal(householdId, goalId);
    const [allocations, householdAllocations, householdGoals, assetValues, assetNames, cashflowEvents] =
      await Promise.all([
        this.goalsRepository.findAllocationsByGoal(householdId, goalId),
        this.goalsRepository.findAllocationsByHousehold(householdId),
        this.goalsRepository.findFinancialGoalsByHousehold(householdId),
        this.assetValueMap(householdId),
        this.assetNameMap(householdId),
        this.cashflowEventsRepository.findCashflowEventsByHousehold(householdId),
      ]);

    const through = endOfMonthIso(todayInTimeZone());
    const projectedValues = walletValuesAfterPendingOutflows(
      assetValues,
      cashflowEvents,
      through,
    );

    // Only the wallets THIS goal draws on. A bill against an unrelated account
    // costs this goal nothing and must not appear on its screen.
    const goalAssetIds = new Set(
      allocations.map((allocation) => allocation.assetId),
    );
    const events = cashflowEvents
      .filter(
        (event) =>
          event.direction === 'outgoing' &&
          event.settlementAssetId !== null &&
          event.settlementAssetId !== undefined &&
          goalAssetIds.has(event.settlementAssetId) &&
          LIVE_CASHFLOW_STATUSES.includes(event.status) &&
          event.expectedDate <= through,
      )
      .map((event) => ({
        id: event.id,
        name: event.name,
        amount: event.amount,
        expectedDate: event.expectedDate,
        assetId: event.settlementAssetId as string,
        assetName: assetNames.get(event.settlementAssetId as string) ?? '',
      }))
      .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));

    if (events.length === 0) {
      return null;
    }

    const inputs = allocations.map(toAllocationInput);
    const claims = householdGoals.map((item) => ({
      goalId: item.id,
      priority: item.priority,
      allocations: householdAllocations
        .filter((allocation) => allocation.financialGoalId === item.id)
        .map(toAllocationInput),
    }));

    // Percent claims keep the untouched wallet as their basis throughout — see
    // `allocationValue`. Only the cap moves, which is what makes a bill big
    // enough to eat into set-aside money show up and a smaller one not.
    const currentAmount = resolveGoalProgressAmount(inputs, assetValues);
    const projectedAmount = resolveGoalProgressAmount(
      inputs,
      projectedValues,
      assetValues,
    );
    const currentPace = resolveWalletShareByGoal(claims, assetValues).get(goalId);
    const projectedPace = resolveWalletShareByGoal(
      claims,
      projectedValues,
      assetValues,
    ).get(goalId);

    return {
      householdId,
      goalId,
      /** Last day covered — the end of the current month. */
      throughDate: through,
      events,
      outflowAmount: events.reduce((sum, event) => sum + event.amount, 0),
      /** What the goal holds now, and once these land. */
      currentAmount,
      projectedAmount,
      /**
       * This month's contribution, now and after. The DECLARED pace is left
       * alone: it is what the household committed to, and the projection here
       * describes this month only — the wallet refills next month, so carrying
       * a squeezed month into the long-range chart would report a pessimistic
       * finish date the household never chose.
       */
      plannedMonthlyContribution: goal.plannedMonthlyContribution,
      currentPace: currentPace?.amount ?? 0,
      projectedPace: projectedPace?.amount ?? 0,
    };
  }

  async listAllocations(householdId: string, goalId: string) {
    await this.ensureFinancialGoal(householdId, goalId);
    const [allocations, assetValues] = await Promise.all([
      this.goalsRepository.findAllocationsByGoal(householdId, goalId),
      this.assetValueMap(householdId),
    ]);
    // Cards report what each claim is worth NOW. What scheduled outflows will
    // cost is answered once, by `scheduledOutflowImpact`, so the same fact is
    // not restated on every row.
    const items = allocations.map((allocation) =>
      toAllocationCard(allocation, assetValues),
    );
    return { householdId, goalId, items, total: items.length };
  }

  async createAllocation(
    householdId: string,
    goalId: string,
    payload: CreateGoalAllocationDto,
  ) {
    const goal = await this.ensureFinancialGoal(householdId, goalId);
    if (!payload.assetId) {
      throw new BadRequestException('assetId is required');
    }
    const shape = normalizeAllocationShape(payload.kind, payload);

    const [existing, assets, existingGoals] = await Promise.all([
      this.goalsRepository.findAllocationsByHousehold(householdId),
      this.assetIndex(householdId),
      this.goalsRepository.findFinancialGoalsByHousehold(householdId),
    ]);
    const assetValues = assets.values;
    const assetValue = assetValues.get(payload.assetId);
    const assetType = assets.types.get(payload.assetId);
    if (assetValue === undefined || assetType === undefined) {
      throw new NotFoundException(`Asset "${payload.assetId}" was not found`);
    }
    if (
      existing.some(
        (allocation) =>
          allocation.financialGoalId === goalId &&
          allocation.assetId === payload.assetId,
      )
    ) {
      throw new BadRequestException(
        'This asset already counts towards this goal. Edit that allocation instead of adding a second one.',
      );
    }

    this.assertWithinAssetValue(
      existing,
      payload.assetId,
      assetValue,
      shape,
      undefined,
    );

    const role = payload.role ?? defaultRoleForType(assetType);
    this.assertShareWithinWallet(
      existing,
      existingGoals,
      payload.assetId,
      goal.priority,
      normalizeSharePercent(payload.sharePercent ?? null, assetType, role),
      goalId,
    );
    const allocation: GoalAssetAllocation = {
      id: this.goalsRepository.createId('goal-allocation'),
      householdId,
      financialGoalId: goalId,
      assetId: payload.assetId,
      kind: shape.kind,
      role,
      monthlyContribution: normalizeMonthlyContribution(
        payload.monthlyContribution ?? null,
        assetType,
        role,
      ),
      sharePercent: normalizeSharePercent(
        payload.sharePercent ?? null,
        assetType,
        role,
      ),
      allocatedAmount: shape.allocatedAmount,
      percent: shape.percent,
      note: payload.note?.trim() ?? '',
    };
    // The write and the goal's pace land together: a share carrying a monthly
    // figure that the goal's mirror does not include is a goal reporting a plan
    // smaller than the one the household typed.
    await this.prisma.runInTransaction(async () => {
      await this.goalsRepository.insertAllocation(allocation);
      await this.syncGoalPace(householdId, goalId, [
        ...existing.filter((other) => other.financialGoalId === goalId),
        allocation,
      ]);
    });
    return toAllocationCard(allocation, assetValues);
  }

  async updateAllocation(
    householdId: string,
    goalId: string,
    allocationId: string,
    payload: UpdateGoalAllocationDto,
  ) {
    const goal = await this.ensureFinancialGoal(householdId, goalId);
    const current = await this.goalsRepository.findAllocationById(
      householdId,
      allocationId,
    );
    if (!current || current.financialGoalId !== goalId) {
      throw new NotFoundException(`Allocation "${allocationId}" was not found`);
    }

    // The kind may change; when it does, the value for the NEW kind must be
    // supplied, because the column the old kind used is cleared on write.
    const kind = payload.kind ?? current.kind;
    const shape = normalizeAllocationShape(kind, {
      allocatedAmount:
        payload.allocatedAmount ??
        (kind === current.kind
          ? (current.allocatedAmount ?? undefined)
          : undefined),
      percent:
        payload.percent ??
        (kind === current.kind ? (current.percent ?? undefined) : undefined),
    });

    const [existing, assets, existingGoals] = await Promise.all([
      this.goalsRepository.findAllocationsByHousehold(householdId),
      this.assetIndex(householdId),
      this.goalsRepository.findFinancialGoalsByHousehold(householdId),
    ]);
    const assetValues = assets.values;
    const assetValue = assetValues.get(current.assetId);
    const assetType = assets.types.get(current.assetId);
    if (assetValue === undefined || assetType === undefined) {
      throw new NotFoundException(`Asset "${current.assetId}" was not found`);
    }
    this.assertWithinAssetValue(
      existing,
      current.assetId,
      assetValue,
      shape,
      allocationId,
    );

    const role = payload.role ?? current.role;
    this.assertShareWithinWallet(
      existing,
      existingGoals,
      current.assetId,
      goal.priority,
      normalizeSharePercent(
        payload.sharePercent === undefined
          ? current.sharePercent
          : payload.sharePercent,
        assetType,
        role,
      ),
      goalId,
      allocationId,
    );
    const next: GoalAssetAllocation = {
      ...current,
      kind: shape.kind,
      role,
      // `undefined` leaves the stored figure alone; an explicit `null` clears
      // it. Those are different requests — "I am only renaming this share" must
      // not silently drop the pace it declares.
      monthlyContribution: normalizeMonthlyContribution(
        payload.monthlyContribution === undefined
          ? current.monthlyContribution
          : payload.monthlyContribution,
        assetType,
        role,
      ),
      // Same rule: `undefined` keeps the declared share, `null` drops it.
      sharePercent: normalizeSharePercent(
        payload.sharePercent === undefined
          ? current.sharePercent
          : payload.sharePercent,
        assetType,
        role,
      ),
      allocatedAmount: shape.allocatedAmount,
      percent: shape.percent,
      note: payload.note?.trim() ?? current.note,
    };
    await this.prisma.runInTransaction(async () => {
      await this.goalsRepository.updateAllocation(allocationId, next);
      await this.syncGoalPace(
        householdId,
        goalId,
        existing
          .filter((other) => other.financialGoalId === goalId)
          .map((other) => (other.id === allocationId ? next : other)),
      );
    });
    return toAllocationCard(next, assetValues);
  }

  async deleteAllocation(
    householdId: string,
    goalId: string,
    allocationId: string,
  ) {
    await this.ensureFinancialGoal(householdId, goalId);
    const current = await this.goalsRepository.findAllocationById(
      householdId,
      allocationId,
    );
    if (!current || current.financialGoalId !== goalId) {
      throw new NotFoundException(`Allocation "${allocationId}" was not found`);
    }

    const [siblings, assets] = await Promise.all([
      this.goalsRepository.findAllocationsByGoal(householdId, goalId),
      this.assetIndex(householdId),
    ]);
    const remaining = siblings.filter((other) => other.id !== allocationId);
    // Removing the last wallet used to be refused, to mirror the create-time
    // rule. Both are gone for the same reason — see `createFinancialGoal`: the
    // state is reachable by deleting the asset instead, so refusing it here only
    // moved the household to the route that had no guard at all. The goal is now
    // allowed to lose its last wallet, and the `goal_without_wallet` attention
    // signal says so on every read.

    await this.prisma.runInTransaction(async () => {
      await this.goalsRepository.deleteAllocation(householdId, allocationId);
      await this.syncGoalPace(householdId, goalId, remaining);
    });
    return { deleted: true, allocationId };
  }

  /**
   * Rewrite the goal's stored pace from the shares it will have.
   *
   * `financial_goals.planned_monthly_contribution` is a mirror kept so that the
   * goals list, the dashboard and the forecast can show a pace without touching
   * `goal_asset_allocations`. Every allocation write therefore ends here, in the
   * same transaction, and the allocations remain the only thing anyone edits.
   *
   * `allocations` is passed in — the caller already knows the post-write set,
   * and re-reading it inside the transaction would only risk reading the state
   * before its own write.
   */
  private async syncGoalPace(
    householdId: string,
    goalId: string,
    allocations: GoalAssetAllocation[],
  ): Promise<void> {
    await this.goalsRepository.updatePlannedMonthlyContribution(
      householdId,
      goalId,
      resolvePlannedMonthlyContribution(allocations.map(toAllocationInput)),
    );
  }

  /**
   * Reject a claim that would promise more of an asset than it holds.
   *
   * Checked across ALL goals, not just this one — the point is that the same
   * 100tr of stocks cannot be promised to both the car and the house. Claims
   * are compared at the asset's live value, so a percent claim and a fixed one
   * are measured on the same scale.
   *
   * Only the moment of writing is guarded. A later price fall is NOT an error —
   * the household did nothing wrong, and `resolveGoalProgressAmount` caps a
   * fixed claim at the asset's value, so the goal reports the truth without
   * anyone having to fix anything.
   */
  /**
   * The shares of one wallet, among goals tied at one priority, cannot exceed
   * 100%.
   *
   * Sibling to `assertWithinAssetValue`: that rule stops a household promising
   * more MONEY than a wallet holds, this one stops them promising more of its
   * monthly ROOM than exists. Both span rows the DB cannot see together, so both
   * are checked here at write time.
   *
   * Only goals at the SAME priority are counted. A `high` goal and a `low` one
   * never divide anything — the high one is served first and takes what it needs
   * — so their shares are unrelated numbers and adding them would refuse a pair
   * that never competed.
   *
   * The total is NOT required to reach 100. The first goal on a wallet declares
   * its share before the second one exists, and demanding a full 100 would
   * either block that first write or force a number the household would have to
   * come back and undo.
   */
  private assertShareWithinWallet(
    allocations: GoalAssetAllocation[],
    goals: FinancialGoal[],
    assetId: string,
    priority: GoalPriority,
    incomingShare: number | null,
    excludeGoalId?: string,
    excludeAllocationId?: string,
  ): void {
    if (incomingShare === null) {
      return;
    }
    const samePriority = new Set(
      goals
        .filter(
          (goal) => goal.priority === priority && goal.id !== excludeGoalId,
        )
        .map((goal) => goal.id),
    );
    const claimed = allocations
      .filter(
        (allocation) =>
          allocation.assetId === assetId &&
          allocation.id !== excludeAllocationId &&
          allocation.role === 'contribution' &&
          allocation.sharePercent != null &&
          samePriority.has(allocation.financialGoalId),
      )
      .reduce((sum, allocation) => sum + (allocation.sharePercent ?? 0), 0);

    if (claimed + incomingShare > 100) {
      const free = Math.max(0, 100 - claimed);
      throw new BadRequestException(
        `Other goals at this priority already take ${claimed}% of this wallet, so only ${free}% is left to give this one.`,
      );
    }
  }

  private assertWithinAssetValue(
    allocations: GoalAssetAllocation[],
    assetId: string,
    assetValue: number,
    shape: AllocationShape,
    excludeAllocationId?: string,
    /**
     * Claims made earlier in the SAME request but not yet written. Creating a
     * goal declares several allocations at once, and two of them could together
     * exceed one asset even though each fits on its own.
     */
    pending: GoalAllocationInput[] = [],
  ): void {
    const others = allocations
      .filter((allocation) => allocation.id !== excludeAllocationId)
      .map(toAllocationInput)
      .concat(pending);
    const alreadyClaimed = sumAllocatedAgainstAsset(
      others,
      assetId,
      assetValue,
    );
    // The DECLARED figure, not the capped one. `sumAllocatedAgainstAsset` caps
    // each claim at the asset's value — right for reporting progress, wrong for
    // this check: a 500tr claim against a 100tr asset would arrive here as 100tr
    // and pass, letting the household declare a share the asset cannot cover.
    const incoming =
      shape.kind === 'percent'
        ? (assetValue * (shape.percent ?? 0)) / 100
        : (shape.allocatedAmount ?? 0);
    if (alreadyClaimed + incoming > assetValue) {
      const free = Math.max(0, assetValue - alreadyClaimed);
      throw new BadRequestException(
        `Only ${free} of this asset is still unassigned, so it cannot also count ${incoming} towards this goal.`,
      );
    }
  }

  private async ensureFinancialGoal(householdId: string, goalId: string) {
    await this.goalsRepository.assertHousehold(householdId);
    const goal = await this.goalsRepository.findFinancialGoalById(
      householdId,
      goalId,
    );
    if (!goal) {
      throw new NotFoundException(`Financial goal "${goalId}" was not found`);
    }
    return goal;
  }
}

/** The value shape of an allocation, after `kind` has been validated. */
interface AllocationShape {
  kind: 'fixed' | 'percent';
  allocatedAmount: number | null;
  percent: number | null;
}

/**
 * Validate an allocation's kind + value and return exactly the two columns to
 * store. The DB CHECK allows only one of them to be set, so the unused one is
 * explicitly null rather than left undefined.
 *
 * These DTOs carry no class-validator decorators (repo convention), so this is
 * the only place the rules are enforced.
 */
function normalizeAllocationShape(
  kind: 'fixed' | 'percent' | undefined,
  value: { allocatedAmount?: number; percent?: number },
): AllocationShape {
  if (kind === 'percent') {
    const percent = value.percent;
    if (percent == null || !Number.isFinite(percent)) {
      throw new BadRequestException(
        'A percent allocation needs a percent (0 < percent <= 100).',
      );
    }
    if (percent <= 0 || percent > 100) {
      throw new BadRequestException('percent must be above 0 and at most 100');
    }
    return { kind: 'percent', allocatedAmount: null, percent };
  }
  if (kind === 'fixed') {
    const allocatedAmount = value.allocatedAmount;
    if (allocatedAmount == null || !Number.isFinite(allocatedAmount)) {
      throw new BadRequestException(
        'A fixed allocation needs an allocatedAmount.',
      );
    }
    if (allocatedAmount < 0) {
      throw new BadRequestException('allocatedAmount cannot be negative');
    }
    return { kind: 'fixed', allocatedAmount, percent: null };
  }
  throw new BadRequestException('kind must be "fixed" or "percent"');
}

/**
 * Whether an asset is a wallet — money the household can put in and take out at
 * face value, with no market price in between.
 *
 * `cash` and `bank_account` only. A savings deposit is money too, but it is
 * money placed under a term: contributing to it monthly is not the same act, and
 * widening this list is a product decision, not a detail.
 */
function isWalletType(assetType: string | undefined): boolean {
  return assetType === 'cash' || assetType === 'bank_account';
}

/**
 * The role a new share takes when the household did not choose one.
 *
 * Wallets are what money is contributed THROUGH, so they seed as the
 * contribution source; everything else is value already held. Only a default: a
 * household with a spending wallet and a savings wallet must be able to say only
 * the second one feeds this goal, which is why the role is stored rather than
 * derived on read.
 */
function defaultRoleForType(assetType: string): GoalAllocationRole {
  return isWalletType(assetType) ? 'contribution' : 'holding';
}

/**
 * Validate a share's monthly figure against the share it sits on.
 *
 * A pace has to name the account the money comes out of, so only a wallet may
 * carry one, and only while it is the goal's contribution source: the pace panel
 * measures kept-or-missed on `contribution` shares alone, so a figure on a
 * `holding` would be added to the target and then reported short every month,
 * for money nobody planned to move.
 *
 * Rejected rather than quietly dropped — a household that typed 5tr against
 * their gold has misunderstood something, and silently storing nothing would let
 * them keep believing it.
 */
function normalizeMonthlyContribution(
  monthlyContribution: number | null,
  assetType: string,
  role: GoalAllocationRole,
): number | null {
  if (monthlyContribution == null) {
    return null;
  }
  if (!Number.isFinite(monthlyContribution) || monthlyContribution < 0) {
    throw new BadRequestException('monthlyContribution cannot be negative');
  }
  if (!isWalletType(assetType)) {
    throw new BadRequestException(
      'Only a cash or bank account can be given a monthly amount — that is where money is put in from. Gold, stocks and other holdings count towards the goal, but nothing is paid into them on a schedule.',
    );
  }
  if (role !== 'contribution') {
    throw new BadRequestException(
      'This wallet is marked as a holding, so it is not what feeds the goal. Set its role to "contribution" to give it a monthly amount.',
    );
  }
  return monthlyContribution;
}

/**
 * The share of a wallet this goal takes when its priority group falls short.
 *
 * Same two rules as the monthly amount: only a wallet, and only a share the goal
 * actually contributes through. A holding is never fed monthly, so it never
 * competes for a wallet's room and a split figure on it would describe nothing.
 */
function normalizeSharePercent(
  sharePercent: number | null,
  assetType: string,
  role: GoalAllocationRole,
): number | null {
  if (sharePercent == null) {
    return null;
  }
  if (
    !Number.isFinite(sharePercent) ||
    sharePercent <= 0 ||
    sharePercent > 100
  ) {
    throw new BadRequestException(
      'A goal’s share of a wallet has to be between 1 and 100 percent.',
    );
  }
  if (!isWalletType(assetType) || role !== 'contribution') {
    throw new BadRequestException(
      'Only a cash or bank account this goal contributes through can carry a share. Gold, stocks and other holdings are not fed monthly, so there is nothing to divide.',
    );
  }
  return sharePercent;
}

/** Entity → the pure domain's input shape. */


/**
 * The wire shape of an allocation. `currentValue` is what this claim is worth
 * right now — the number the UI shows next to the asset, and the one that makes
 * a capped `fixed` claim legible ("50tr declared, 30tr actually there").
 */
function toAllocationCard(
  allocation: GoalAssetAllocation,
  assetValues: ReadonlyMap<string, number>,
) {
  const assetValue = assetValues.get(allocation.assetId) ?? 0;
  const currentValue = resolveGoalProgressAmount(
    [toAllocationInput(allocation)],
    assetValues,
  );

  return {
    id: allocation.id,
    financialGoalId: allocation.financialGoalId,
    assetId: allocation.assetId,
    kind: allocation.kind,
    role: allocation.role,
    monthlyContribution: allocation.monthlyContribution,
    allocatedAmount: allocation.allocatedAmount,
    percent: allocation.percent,
    assetValue,
    currentValue,
    note: allocation.note,
  };
}
