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
import { todayInTimeZone } from '../../common/utils/clock';
import { projectGoal } from './domain/goal-projection';
import {
  buildConversionCredit,
  buildGoalMonthlyProgress,
} from './domain/goal-monthly-progress';
import { buildGoalProgressChange } from './domain/goal-progress-change';
import {
  resolveContributionProgressAmount,
  resolveGoalProgressAmount,
  resolvePlannedMonthlyContribution,
  sumAllocatedAgainstAsset,
} from './domain/goal-progress';
import type { GoalAllocationInput } from './domain/goal-progress';
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

@Injectable()
export class GoalsService {
  constructor(
    @Inject(GOALS_REPOSITORY)
    private readonly goalsRepository: GoalsRepository,
    private readonly prisma: PrismaService,
    private readonly assetsService: AssetsService,
    @Inject(SNAPSHOTS_REPOSITORY)
    private readonly snapshotsRepository: SnapshotsRepository,
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
      values: new Map(assets.map((asset) => [asset.id, asset.currentValue ?? 0])),
      types: new Map(assets.map((asset) => [asset.id, asset.type as string])),
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

    const wantsProjection = (include ?? '')
      .split(',')
      .map((part) => part.trim())
      .includes('projection');
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
    };
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
    const [existing, assets] = await Promise.all([
      this.goalsRepository.findAllocationsByHousehold(householdId),
      this.assetIndex(householdId),
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
        allocatedAmount: shape.allocatedAmount,
        percent: shape.percent,
        note: entry.note?.trim() ?? '',
      });
    }

    // Money is only ever put INTO a goal through a wallet, so a goal with no
    // wallet behind it is one nobody can save towards — its figure would move on
    // the gold price alone, and "did we keep our pace?" would have no source to
    // read. Asked here, where the household is already choosing which money this
    // is, rather than left to be discovered when the pace panel stays empty.
    if (!rows.some((row) => isWalletType(assets.types.get(row.assetId)))) {
      throw new BadRequestException(
        'A goal needs at least one cash or bank account behind it — that is where the money you put in each month comes from. Add one alongside any gold, stocks or other holdings.',
      );
    }

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
    const [points, allocations, assetValues] = await Promise.all([
      this.snapshotsRepository.findGoalProgressPoints(householdId, goalId),
      this.goalsRepository.findAllocationsByGoal(householdId, goalId),
      this.assetValueMap(householdId),
    ]);
    const inputs = allocations.map(toAllocationInput);
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
            date: todayInTimeZone(),
            progressAmount: resolveGoalProgressAmount(inputs, assetValues),
            contributionAmount: resolveContributionProgressAmount(
              inputs,
              assetValues,
            ),
          },
          hasContributionSource: inputs.some(
            (input) => input.role === 'contribution',
          ),
          conversionCreditByMonth: buildConversionCredit(conversions),
        },
      ),
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

  async listAllocations(householdId: string, goalId: string) {
    await this.ensureFinancialGoal(householdId, goalId);
    const [allocations, assetValues] = await Promise.all([
      this.goalsRepository.findAllocationsByGoal(householdId, goalId),
      this.assetValueMap(householdId),
    ]);
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
    await this.ensureFinancialGoal(householdId, goalId);
    if (!payload.assetId) {
      throw new BadRequestException('assetId is required');
    }
    const shape = normalizeAllocationShape(payload.kind, payload);

    const [existing, assets] = await Promise.all([
      this.goalsRepository.findAllocationsByHousehold(householdId),
      this.assetIndex(householdId),
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
        ...existing.filter(
          (other) => other.financialGoalId === goalId,
        ),
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
    await this.ensureFinancialGoal(householdId, goalId);
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

    const [existing, assets] = await Promise.all([
      this.goalsRepository.findAllocationsByHousehold(householdId),
      this.assetIndex(householdId),
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
    // The wallet rule is a rule about the goal, not about creating one: removing
    // the last wallet would leave exactly the goal that create refuses to make,
    // one with nothing to be saved into.
    if (
      isWalletType(assets.types.get(current.assetId)) &&
      !remaining.some((other) => isWalletType(assets.types.get(other.assetId)))
    ) {
      throw new BadRequestException(
        'This is the only cash or bank account behind the goal, and a goal needs one to be saved into. Add another wallet first, or delete the goal.',
      );
    }

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
    const alreadyClaimed = sumAllocatedAgainstAsset(others, assetId, assetValue);
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

/** Entity → the pure domain's input shape. */
function toAllocationInput(allocation: GoalAssetAllocation): GoalAllocationInput {
  return {
    assetId: allocation.assetId,
    kind: allocation.kind,
    role: allocation.role,
    monthlyContribution: allocation.monthlyContribution,
    allocatedAmount: allocation.allocatedAmount,
    percent: allocation.percent,
  };
}

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
    currentValue: resolveGoalProgressAmount(
      [toAllocationInput(allocation)],
      assetValues,
    ),
    note: allocation.note,
  };
}
