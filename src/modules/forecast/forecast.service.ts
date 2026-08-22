import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  addDaysIso,
  todayInTimeZone,
  type IsoDate,
} from '../../common/utils/clock';
import { runForecast } from './domain/forecast';
import { CacheService } from '../../common/cache/cache.service';
import { cacheKeys, cacheTtl } from '../../common/cache/cache.keys';
import { computeFlexibleMoney } from './domain/flexible-money';
import { walletValuesAfterOutflows } from './domain/wallet-values-after-outflows';
import {
  findNewlyAtRisk,
  type AtRiskOccurrence,
} from './domain/at-risk-occurrences';
import { spreadAcrossWallets } from './domain/spread-across-wallets';
import { deriveFinancialState } from './domain/financial-state';
import {
  amountBucket,
  buildSyntheticEvent,
  classifyResult,
  type WhatIfResultType,
} from './domain/what-if';
import {
  projectGoal,
  projectGoalAfterSpend,
  type GoalProjection,
} from '../goals/domain/goal-projection';
import type { ForecastInput, ForecastResult } from './domain/forecast.types';
import type { FlexibleMoneyResult } from './domain/flexible-money';
import { FORECAST_REPOSITORY } from './repositories/forecast.repository.interface';
import type { ForecastRepository } from './repositories/forecast.repository.interface';
import { GOALS_REPOSITORY } from '../goals/repositories/goals.repository.interface';
import type { GoalsRepository } from '../goals/repositories/goals.repository.interface';
import { GoalsService } from '../goals/goals.service';
import type { WhatIfRequestDto } from './dto/what-if.dto';

/** The horizons the product offers (04 §7). Anything else is a 400. */
const ALLOWED_HORIZONS = [7, 30, 60, 90];
const DEFAULT_HORIZON = 30;

export interface WhatIfSideResult {
  flexibleMoneyToday: number;
  /**
   * The horizon figure. Since the protected reserve was retired this IS the
   * flexible-money-over-the-horizon number — there is no second name for it.
   */
  lowestProjectedBalance: number;
  lowestProjectedBalanceDate: IsoDate;
  obligationsCovered: boolean;
  goal: GoalProjection | null;
}

export interface WhatIfResult {
  householdId: string;
  asOfDate: IsoDate;
  horizonDays: number;
  input: WhatIfRequestDto;
  obligationsCovered: boolean;
  before: WhatIfSideResult;
  after: WhatIfSideResult;
  /**
   * What every goal gives up, in money AND in time. Measured across all
   * flexible wallets — what-if names no single wallet.
   */
  goalImpact: Awaited<ReturnType<GoalsService['spendImpactAcrossWallets']>> & {
    /**
     * The part of the spend no wallet could cover. 0 when it fits.
     *
     * Distinct from `obligationsCovered`: this is "the money is not there at
     * all", not "a later bill goes unpaid because of it".
     */
    uncovered: number;
  };
  /**
   * Upcoming obligations this spend would leave uncovered, named.
   *
   * Only the ones it actually breaks: an item already going unpaid before the
   * spend is not this purchase's doing, and blaming it would misattribute a
   * problem the household already had.
   */
  newlyAtRisk: AtRiskOccurrence[];
  delta: {
    flexibleMoneyToday: number;
    lowestProjectedBalance: number;
    goalDelayMonths: number | null;
    goalDelayDays: number | null;
  };
  resultType: WhatIfResultType;
  assumptions: ForecastResult['assumptions'];
}

/**
 * The read-only calculation surface: forecast, flexible money, financial state
 * and what-if.
 *
 * Every method here is a READ. Nothing in this service writes a row — there is
 * no `forecasts` table and no `what_if_scenarios` table, by design (§2.12,
 * §35). Virtual occurrences and synthetic events are objects that never leave
 * memory.
 */
@Injectable()
export class ForecastService {
  private readonly logger = new Logger(ForecastService.name);

  constructor(
    @Inject(FORECAST_REPOSITORY)
    private readonly forecastRepository: ForecastRepository,
    @Inject(GOALS_REPOSITORY)
    private readonly goalsRepository: GoalsRepository,
    // Resolves a goal's progress per its backing mode. Forecast's own `assets`
    // list holds only liquid sources, so a goal backed by gold or crypto could
    // not be valued here without it.
    private readonly goalsService: GoalsService,
    private readonly cache: CacheService,
  ) {}

  /** Validate + clamp the requested horizon. */
  parseHorizon(raw?: string | number): number {
    if (raw === undefined || raw === null || raw === '') {
      return DEFAULT_HORIZON;
    }
    const parsed = Number(raw);
    if (!ALLOWED_HORIZONS.includes(parsed)) {
      throw new BadRequestException(
        `horizon_days must be one of ${ALLOWED_HORIZONS.join(', ')}`,
      );
    }
    return parsed;
  }

  /**
   * Load everything a forecast needs. Exposed so what-if can run the engine
   * twice over ONE bundle instead of querying twice.
   */
  async loadInput(
    householdId: string,
    horizonDays: number,
    asOfDate?: IsoDate,
  ): Promise<ForecastInput> {
    // No `assertHousehold` here: every route that reaches this service is
    // `/api/households/:householdId/*`, and `HouseholdAccessGuard` has already
    // proved the household exists (404) and the caller is a member (403)
    // before the handler ran. Re-checking was a third redundant lookup of the
    // same row per request.
    const bundle =
      await this.forecastRepository.loadForecastBundle(householdId);
    return {
      householdId,
      asOfDate: asOfDate ?? todayInTimeZone(),
      horizonDays,
      ...bundle,
    };
  }

  /**
   * The chokepoint every forecast read funnels through — `flexibleMoney`,
   * `financialState` and `forecastBundle` are all pure functions of this
   * result, so caching here covers all of them and nothing needs its own key.
   *
   * Only the default `asOfDate` (today) is cached. An explicit `asOfDate` comes
   * from the snapshot backfill, not from HTTP — no controller passes one — so
   * caching it would add dated keys that nothing reads twice while making the
   * key space unbounded. Those callers run uncached.
   */
  async forecast(
    householdId: string,
    horizonDays: number,
    asOfDate?: IsoDate,
  ): Promise<ForecastResult> {
    if (asOfDate !== undefined) {
      return runForecast(
        await this.loadInput(householdId, horizonDays, asOfDate),
      );
    }

    return this.cache.wrap(
      cacheKeys.forecast(householdId, horizonDays),
      async () => runForecast(await this.loadInput(householdId, horizonDays)),
      cacheTtl.household,
    );
  }

  async flexibleMoney(
    householdId: string,
    horizonDays: number,
    asOfDate?: IsoDate,
  ): Promise<FlexibleMoneyResult> {
    const forecast = await this.forecast(householdId, horizonDays, asOfDate);
    return computeFlexibleMoney(
      forecast,
      await this.goalCommitments(householdId, forecast),
    );
  }

  /**
   * What the household's goals claim of the SAME liquid money the forecast
   * starts from.
   *
   * The value map is built from the forecast's own `usable_now` sources, so the
   * two figures cannot disagree about what is liquid: an asset the forecast did
   * not count cannot be reported as liquid money already committed. Gold behind
   * a goal is therefore absent here, which is right — it was never part of the
   * liquid total this is a share of.
   *
   * Measured AFTER the horizon's outflows, not against today's balances. An
   * outflow outranks the goals sharing its wallet, so goal money shrinks to make
   * room for it. Using today's balances here while `lowestProjectedBalance` had
   * already subtracted the same outflows charged each one twice, and the hero
   * reported a negative figure for a household that had merely spent from a
   * wallet its goals were saving into (see `walletValuesAfterOutflows`).
   */
  private async goalCommitments(
    householdId: string,
    forecast: ForecastResult,
  ): Promise<number> {
    return this.goalsService.resolveGoalCommitments(
      householdId,
      walletValuesAfterOutflows(forecast),
      // Percent claims stay a percentage of the UNSPENT wallet: an outflow must
      // take unassigned money first, not shave every goal proportionally while
      // free money is still sitting there. See `allocationValue`.
      new Map(
        forecast.liquidSources.map((source) => [source.assetId, source.value]),
      ),
    );
  }

  async financialState(
    householdId: string,
    horizonDays: number,
    asOfDate?: IsoDate,
  ) {
    const forecast = await this.forecast(householdId, horizonDays, asOfDate);
    return deriveFinancialState(
      forecast,
      computeFlexibleMoney(
        forecast,
        await this.goalCommitments(householdId, forecast),
      ),
    );
  }

  /**
   * All three readings of one forecast, from ONE load.
   *
   * `flexibleMoney` and `financialState` are both pure functions OF the
   * forecast — nothing else. Served as three endpoints they made the client
   * issue three requests that each re-loaded the same bundle (5 queries) and
   * re-ran the same engine, for one answer. Home reads all three together, so
   * this is the shape it actually wants. The individual endpoints stay for
   * callers that need only one.
   */
  async forecastBundle(
    householdId: string,
    horizonDays: number,
    asOfDate?: IsoDate,
  ): Promise<{
    forecast: ForecastResult;
    flexibleMoney: FlexibleMoneyResult;
    financialState: ReturnType<typeof deriveFinancialState>;
  }> {
    const forecast = await this.forecast(householdId, horizonDays, asOfDate);
    const flexibleMoney = computeFlexibleMoney(
      forecast,
      await this.goalCommitments(householdId, forecast),
    );
    return {
      forecast,
      flexibleMoney,
      financialState: deriveFinancialState(forecast, flexibleMoney),
    };
  }

  /**
   * Stateless simulation (§26D). Loads the bundle ONCE, runs the engine twice.
   *
   * Nothing is written — not an audit log, not a scenario row. Only a bucketed
   * analytics line, which deliberately excludes every real figure.
   */
  async whatIf(
    householdId: string,
    payload: WhatIfRequestDto,
  ): Promise<WhatIfResult> {
    const horizonDays = this.parseHorizon(payload.horizonDays);
    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a positive number');
    }
    if (!payload.plannedDate) {
      throw new BadRequestException('plannedDate is required');
    }

    const input = await this.loadInput(householdId, horizonDays);
    const { asOfDate } = input;
    // Derive the window bound directly rather than running the whole engine
    // just to read a date off it.
    const horizonEnd = addDaysIso(asOfDate, horizonDays);

    if (payload.plannedDate < asOfDate || payload.plannedDate > horizonEnd) {
      throw new BadRequestException(
        `plannedDate must fall between ${asOfDate} and ${horizonEnd}`,
      );
    }

    const goal = payload.goalId
      ? await this.goalsRepository.findFinancialGoalById(
          householdId,
          payload.goalId,
        )
      : undefined;
    if (payload.goalId && !goal) {
      throw new BadRequestException(
        `Financial goal "${payload.goalId}" was not found`,
      );
    }

    const goalInput = goal
      ? {
          goalId: goal.id,
          targetAmount: goal.targetAmount,
          // Resolved per backing mode — the stored column is meaningless for an
          // asset_backed goal, so projecting from it would invent a figure.
          currentAmount: await this.goalsService.resolveProgressAmount(
            householdId,
            goal,
          ),
          plannedMonthlyContribution: goal.plannedMonthlyContribution,
          targetDate:
            goal.targetDate && goal.targetDate !== 'No deadline'
              ? goal.targetDate
              : null,
          status: 'active' as const,
          asOfDate,
        }
      : null;

    const beforeForecast = runForecast(input);
    const beforeGoal = goalInput ? projectGoal(goalInput) : null;

    const synthetic = buildSyntheticEvent({
      amount,
      plannedDate: payload.plannedDate,
      label: payload.label,
    });
    const afterForecast = runForecast({
      ...input,
      options: { ...input.options, syntheticEvents: [synthetic] },
    });

    /**
     * Both sides carry goal money, and each side measures it against ITS OWN
     * wallet values.
     *
     * These two calls used to pass no `goalCommitments` at all, so what-if
     * reported flexible money that ignored every goal — a bigger figure than
     * Home showed for the same household, from the screen whose whole job is to
     * be trusted about consequences.
     *
     * Resolving the after-side against the after-forecast is what makes the
     * spend's cost to the goals appear: the wallet it settles from is already
     * lowered there, so the goals on it claim less (see
     * `walletValuesAfterOutflows`).
     */
    const [beforeFlexible, afterFlexible] = [
      computeFlexibleMoney(
        beforeForecast,
        await this.goalCommitments(householdId, beforeForecast),
      ),
      computeFlexibleMoney(
        afterForecast,
        await this.goalCommitments(householdId, afterForecast),
      ),
    ];

    const afterGoalResult = goalInput
      ? projectGoalAfterSpend(goalInput, amount, {
          takenFromGoal: payload.takeFromGoal === true,
        })
      : null;

    const resultType = classifyResult(afterForecast);

    // Analytics: bucket + shape only. Never the amount, never the balances —
    // the household's figures stay theirs (§26D).
    this.logger.log(
      `what_if_run ${JSON.stringify({
        householdId,
        hasGoal: Boolean(goal),
        amountBucket: amountBucket(amount),
        resultType,
      })}`,
    );

    const side = (
      forecast: ForecastResult,
      flexible: FlexibleMoneyResult,
      goalProjection: GoalProjection | null,
    ): WhatIfSideResult => ({
      flexibleMoneyToday: flexible.flexibleMoneyToday,
      lowestProjectedBalance: forecast.lowestProjectedBalance,
      lowestProjectedBalanceDate: forecast.lowestProjectedBalanceDate,
      obligationsCovered: forecast.obligationsCovered,
      goal: goalProjection,
    });

    const before = side(beforeForecast, beforeFlexible, beforeGoal);
    const after = side(
      afterForecast,
      afterFlexible,
      afterGoalResult?.projection ?? null,
    );

    /**
     * What the spend costs EVERY goal, split into this month's contribution and
     * money already set aside, plus how much later each goal lands.
     *
     * Measured across every wallet the forecast counts as flexible, because
     * what-if asks a household-level question — "what if we spent this" — and
     * has no wallet to name. The two maps are the same before/after values the
     * balances came from, so the goal cost and the cash-flow picture describe
     * one spend rather than two.
     *
     * The same resolver the cashflow form uses, so a what-if and the event it
     * becomes cannot report different costs for the same spend.
     */
    const walletsBefore = walletValuesAfterOutflows(beforeForecast);
    /**
     * Where a nameless spend comes from: one wallet at a time, least-promised
     * money first.
     *
     * The what-if event carries no `settlementAssetId` — the household is asking
     * about a purchase, not filing a payment — so the simulation has to choose,
     * and draining a wallet fully before moving to the next is what actually
     * happens when people pay for things. Least-promised first keeps the answer
     * from overstating the cost to the goals (see `spreadAcrossWallets`).
     */
    const drain = spreadAcrossWallets(
      walletsBefore,
      await this.goalsService.goalClaimsByWallet(householdId, walletsBefore),
      amount,
    );
    const goalImpact = await this.goalsService.spendImpactAcrossWallets(
      householdId,
      walletsBefore,
      drain.values,
    );

    return {
      householdId,
      asOfDate,
      horizonDays,
      input: payload,
      obligationsCovered: after.obligationsCovered,
      before,
      after,
      goalImpact: { ...goalImpact, uncovered: drain.uncovered },
      /**
       * WHICH bills stop being payable — not just that something does.
       *
       * `obligationsCovered: false` is enough to colour a badge and useless for
       * deciding anything: what-if exists to answer "what happens if I spend
       * this", and "one of your bills stops being payable" is only an answer
       * once it names the bill and the date.
       */
      newlyAtRisk: findNewlyAtRisk(beforeForecast, afterForecast),
      delta: {
        flexibleMoneyToday:
          after.flexibleMoneyToday - before.flexibleMoneyToday,
        lowestProjectedBalance:
          after.lowestProjectedBalance - before.lowestProjectedBalance,
        goalDelayMonths: afterGoalResult?.goalDelayMonths ?? null,
        goalDelayDays: afterGoalResult?.goalDelayDays ?? null,
      },
      resultType,
      assumptions: afterForecast.assumptions,
    };
  }

  /** The projection for one goal (§26C). */
  async goalProjection(
    householdId: string,
    goalId: string,
    asOfDate?: IsoDate,
  ) {
    const goal = await this.goalsRepository.findFinancialGoalById(
      householdId,
      goalId,
    );
    if (!goal) {
      throw new BadRequestException(`Financial goal "${goalId}" was not found`);
    }
    return projectGoal({
      goalId: goal.id,
      targetAmount: goal.targetAmount,
      // Resolved per backing mode, same as the what-if path above.
      currentAmount: await this.goalsService.resolveProgressAmount(
        householdId,
        goal,
      ),
      plannedMonthlyContribution: goal.plannedMonthlyContribution,
      targetDate:
        goal.targetDate && goal.targetDate !== 'No deadline'
          ? goal.targetDate
          : null,
      status: 'active',
      asOfDate: asOfDate ?? todayInTimeZone(),
    });
  }
}
