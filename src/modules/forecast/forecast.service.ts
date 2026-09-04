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
  applyAssetSale,
  buildSyntheticEvent,
  classifyResult,
  isSellableForecastAsset,
  UNASSIGNED_WALLET_ID,
  type AppliedAssetSale,
  type WhatIfResultType,
} from './domain/what-if';
import type { AssetType } from '../assets/entities/asset.entity';
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

/**
 * One wallet's part in paying for the spend.
 *
 * The drain map is already computed to cost the goals; without naming the
 * wallets it stays an internal step, and the household is left to trust a
 * figure they cannot check. Naming them turns "mục tiêu giảm 2tr" into
 * something they can verify against the accounts they actually hold.
 */
export interface WhatIfWalletDraw {
  assetId: string;
  name: string;
  /**
   * What the wallet held on its OWN before the spend — the after-outflows
   * value, with any sale proceeds excluded. Those are reported as `fromSale`,
   * or a wallet holding 13tr would read as having paid 100tr.
   */
  before: number;
  /** Taken from this wallet. Always > 0: untouched wallets are not listed. */
  taken: number;
  /** How much of `taken` was money the simulated sale put here. */
  fromSale: number;
}

/**
 * Where the money comes from, in the two vocabularies that answer different
 * questions.
 *
 * `free` / `fromPace` / `fromSetAside` is the SEMANTIC split: what kind of
 * money gave way. It is the answer to "did this cost me anything that was
 * promised", and it is the one that decides whether a purchase feels
 * affordable.
 *
 * `wallets` is the LITERAL split: which accounts it came out of. Secondary,
 * because the household did not name a wallet — the simulation chose — so it
 * belongs behind a disclosure rather than in the headline.
 *
 * The two always describe one spend: both are derived from the same `drain`.
 */
export interface WhatIfFundingSource {
  /**
   * Proceeds of the simulated sale. Its own category because it is not money
   * the household already had — folding it into `free` would report a wallet
   * as having covered a spend it could not have.
   */
  fromSale: number;
  /** Money no goal had claimed. Spent first, everywhere, before any goal. */
  free: number;
  /** Mirrors `goalImpact.totalPaceReduction` — this month's contribution. */
  fromPace: number;
  /** Mirrors `goalImpact.totalSetAsideReduction` — money already set aside. */
  fromSetAside: number;
  /** Wallets that actually gave money up, most-drained first. */
  wallets: WhatIfWalletDraw[];
}

/**
 * The liquid picture the shortfall is measured from.
 *
 * `shortfall` is what the household cannot pay from money usable TODAY. It is
 * not `obligationsCovered` (the spend is `planned`, so that can never flip) and
 * not a negative low point (a horizon fact). It is the one signal that means
 * "the money is not there yet", so it is what the funding step keys on.
 */
export interface WhatIfLiquidity {
  /** Immediately-usable money after the horizon's counted outflows. */
  liquidAvailable: number;
  /** `max(0, amount − liquidAvailable)`. 0 when the spend fits. */
  shortfall: number;
}

/** An asset the household could sell to fund the spend. Never a suggestion. */
export interface WhatIfFundingOption {
  assetId: string;
  name: string;
  type: AssetType;
  value: number;
  liquidity: 'not_immediately_usable' | 'long_term';
  /** What the goals hold of it — the cost of selling, before committing. */
  goalClaimedAmount: number;
}

/** One sold holding, as applied. */
export interface WhatIfAppliedSaleLine {
  assetId: string;
  name: string;
  amount: number;
  assetValueBefore: number;
  assetValueAfter: number;
}

/** The sale as applied, echoing the choices the engine made. */
export interface WhatIfAppliedSale {
  /** Every holding sold, in the order the caller listed them. */
  lines: WhatIfAppliedSaleLine[];
  /** Gross proceeds asked for, across every line. */
  amount: number;
  /** What lands in the wallet. Equal to `amount` — a hypothetical has no fee. */
  netProceeds: number;
  /** The wallet the household chose, or `UNASSIGNED_WALLET_ID`. */
  receivingAssetId: string;
  receivingName: string;
}

export interface WhatIfResult {
  householdId: string;
  asOfDate: IsoDate;
  horizonDays: number;
  input: WhatIfRequestDto;
  obligationsCovered: boolean;
  before: WhatIfSideResult;
  after: WhatIfSideResult;
  /** What the spend needs versus what is usable today. */
  liquidity: WhatIfLiquidity;
  /** What could be sold to close a shortfall. Empty when the spend fits. */
  fundingOptions: WhatIfFundingOption[];
  /** Set only when `input.assetSale` was supplied and applied. */
  assetSale: WhatIfAppliedSale | null;
  /** The third side: after the sale AND the spend. `null` without a sale. */
  afterSale: WhatIfSideResult | null;
  deltaWithSale: {
    flexibleMoneyToday: number;
    lowestProjectedBalance: number;
  } | null;
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
   * Where the spend actually comes from — semantic split plus the wallets.
   *
   * Derived from the same `drain` as `goalImpact`, so the two can never
   * disagree about what this one spend costs.
   */
  fundingSource: WhatIfFundingSource;
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
    // `/api/v1/households/:householdId/*`, and `HouseholdAccessGuard` has already
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

    // Step 2, when asked for: the assets being sold, and the wallet the money
    // lands in. All named by the caller — see memory/what-if.md.
    const saleRequest = payload.assetSale;
    const soldAssets: (typeof input.assets)[number][] = [];
    let receivingAsset: (typeof input.assets)[number] | undefined;
    if (saleRequest) {
      const lines = saleRequest.lines ?? [];
      if (lines.length === 0) {
        throw new BadRequestException('assetSale.lines must not be empty');
      }

      const seen = new Set<string>();
      for (const line of lines) {
        const saleAmount = Number(line.amount);
        if (!Number.isFinite(saleAmount) || saleAmount <= 0) {
          throw new BadRequestException(
            'assetSale.lines[].amount must be a positive number',
          );
        }
        if (!line.assetId) {
          throw new BadRequestException(
            'assetSale.lines[].assetId is required',
          );
        }
        // The same holding twice would sell more of it than exists, one line
        // at a time, with each line passing its own bound.
        if (seen.has(line.assetId)) {
          throw new BadRequestException(
            `Asset "${line.assetId}" appears in assetSale.lines more than once`,
          );
        }
        seen.add(line.assetId);

        const soldAsset = input.assets.find(
          (asset) => asset.assetId === line.assetId,
        );
        if (!soldAsset) {
          throw new BadRequestException(
            `Asset "${line.assetId}" was not found`,
          );
        }
        if (!isSellableForecastAsset(soldAsset)) {
          throw new BadRequestException(
            `Asset "${line.assetId}" cannot be sold to fund a spend`,
          );
        }
        // An input bound, not a clamped figure: you cannot sell more than you
        // hold, and the real sale enforces the same rule.
        if (saleAmount > soldAsset.value) {
          throw new BadRequestException(
            `assetSale.lines[].amount exceeds the value of asset "${line.assetId}"`,
          );
        }
        soldAssets.push(soldAsset);
      }

      if (!saleRequest.toAssetId) {
        throw new BadRequestException('assetSale.toAssetId is required');
      }
      /**
       * A household with no `usable_now` wallet has no account to name, and
       * used to hit a validation it could not satisfy. The proceeds are still
       * usable money — they simply sit in no account yet.
       */
      if (saleRequest.toAssetId !== UNASSIGNED_WALLET_ID) {
        receivingAsset = input.assets.find(
          (asset) => asset.assetId === saleRequest.toAssetId,
        );
        if (!receivingAsset) {
          throw new BadRequestException(
            `Asset "${saleRequest.toAssetId}" was not found`,
          );
        }
        // Proceeds have to land somewhere spendable, or the sale funds nothing.
        if (receivingAsset.liquidity !== 'usable_now') {
          throw new BadRequestException(
            `Asset "${saleRequest.toAssetId}" cannot receive sale proceeds`,
          );
        }
        if (seen.has(receivingAsset.assetId)) {
          throw new BadRequestException(
            'assetSale.toAssetId must differ from the assets being sold',
          );
        }
      } else if (
        input.assets.some((asset) => asset.liquidity === 'usable_now')
      ) {
        // The sentinel is the answer for a household with no wallet, never a
        // way for one with wallets to park money outside its goals' reach.
        throw new BadRequestException(
          'assetSale.toAssetId must name a wallet when the household has one',
        );
      }
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
     * The wallets the spend draws on, and what the goals claim of each.
     *
     * Resolved here because the funding sale needs them to pick a receiving
     * wallet before the third run.
     */
    const walletsBefore = walletValuesAfterOutflows(beforeForecast);
    const claimsBefore = await this.goalsService.goalClaimsByWallet(
      householdId,
      walletsBefore,
    );

    /**
     * The sale, as a t0 conversion: value leaves the sold asset and lands in a
     * wallet, before anything is spent. Modelled as a rebalance rather than a
     * synthetic inflow — see memory/forecast-and-flexible-money.md.
     */
    const appliedSale: AppliedAssetSale | null =
      saleRequest && soldAssets.length > 0
        ? {
            lines: saleRequest.lines.map((line) => ({
              assetId: line.assetId,
              amount: Number(line.amount),
            })),
            amount: saleRequest.lines.reduce(
              (sum, line) => sum + Number(line.amount),
              0,
            ),
            receivingAssetId: receivingAsset?.assetId ?? null,
          }
        : null;

    const afterSaleForecast = appliedSale
      ? runForecast({
          ...input,
          assets: applyAssetSale(input.assets, appliedSale),
          options: { ...input.options, syntheticEvents: [synthetic] },
        })
      : null;

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
    const afterSaleFlexible = afterSaleForecast
      ? computeFlexibleMoney(
          afterSaleForecast,
          await this.goalCommitments(householdId, afterSaleForecast),
        )
      : null;

    const afterGoalResult = goalInput
      ? projectGoalAfterSpend(goalInput, amount, {
          takenFromGoal: payload.takeFromGoal === true,
        })
      : null;

    // The world the household is looking at: with a sale applied, the client
    // renders the after-SALE side as the answer, so the tone and the
    // obligations flag have to describe that same world.
    const answerForecast = afterSaleForecast ?? afterForecast;
    const resultType = classifyResult(answerForecast);

    // Analytics: bucket + shape only. Never the amount, never the balances —
    // the household's figures stay theirs (§26D).
    this.logger.log(
      `what_if_run ${JSON.stringify({
        householdId,
        hasGoal: Boolean(goal),
        hasAssetSale: Boolean(appliedSale),
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
     * has no wallet to name. The maps are the same before/after values the
     * balances came from, so the goal cost and the cash-flow picture describe
     * one spend rather than two.
     *
     * The same resolver the cashflow form uses, so a what-if and the event it
     * becomes cannot report different costs for the same spend.
     *
     * Where a nameless spend comes from: one wallet at a time, least-promised
     * money first.
     *
     * The what-if event carries no `settlementAssetId` — the household is asking
     * about a purchase, not filing a payment — so the simulation has to choose,
     * and draining a wallet fully before moving to the next is what actually
     * happens when people pay for things. Least-promised first keeps the answer
     * from overstating the cost to the goals (see `spreadAcrossWallets`).
     *
     * With a sale, the spend draws on the wallets the proceeds already landed
     * in, so the money raised is the money spent.
     */
    const walletsToSpendFrom = afterSaleForecast
      ? walletValuesAfterOutflows(afterSaleForecast)
      : walletsBefore;
    const drain = spreadAcrossWallets(
      walletsToSpendFrom,
      afterSaleForecast
        ? await this.goalsService.goalClaimsByWallet(
            householdId,
            walletsToSpendFrom,
          )
        : claimsBefore,
      amount,
    );

    /**
     * Goal cost is measured against a DIFFERENT pair of maps than the spend:
     * the wallets PLUS the sold asset, so a goal backed by that asset is
     * counted at what it actually holds.
     *
     * The sold asset must never reach `spreadAcrossWallets` above — an illiquid
     * asset would then pay for the spend with no sale at all. Wallet-only maps
     * for spending, wallet-plus-sold-asset maps for attribution.
     */
    const goalValuesBefore = new Map(walletsBefore);
    const goalValuesAfter = new Map(drain.values);
    if (appliedSale) {
      const soldById = new Map(
        soldAssets.map((asset) => [asset.assetId, asset]),
      );
      for (const line of appliedSale.lines) {
        const soldAsset = soldById.get(line.assetId);
        if (!soldAsset) continue;
        goalValuesBefore.set(soldAsset.assetId, soldAsset.value);
        goalValuesAfter.set(soldAsset.assetId, soldAsset.value - line.amount);
      }
      // The receiving wallet's credit is already inside `drain.values` via
      // `walletsToSpendFrom`; adding it here would count the proceeds twice.
    }
    const goalImpact = await this.goalsService.spendImpactAcrossWallets(
      householdId,
      goalValuesBefore,
      goalValuesAfter,
    );

    /**
     * The literal half of "where did this come from": which wallets gave money
     * up, and how much each one lost.
     *
     * Read off the same `drain` the goal cost came from rather than recomputed,
     * so the wallets on screen always add up to the spend the goals were
     * charged for. Untouched wallets are dropped — a list of accounts that gave
     * nothing is noise, not evidence.
     */
    const walletNames = new Map(
      beforeForecast.liquidSources.map((source) => [
        source.assetId,
        source.name,
      ]),
    );
    const wallets: WhatIfWalletDraw[] = [...walletsToSpendFrom]
      .map(([assetId, after]) => {
        const taken = after - (drain.values.get(assetId) ?? after);
        /**
         * The wallet's OWN money, before the sale topped it up. Reporting the
         * topped-up figure would say a 13tr wallet paid 100tr, when 86tr of
         * that arrived from the asset that was sold.
         */
        const proceeds =
          appliedSale && assetId === appliedSale.receivingAssetId
            ? appliedSale.amount
            : 0;
        return {
          assetId,
          name: walletNames.get(assetId) ?? assetId,
          before: after - proceeds,
          taken,
          fromSale: Math.min(taken, proceeds),
        };
      })
      .filter((wallet) => wallet.taken > 0)
      .sort((left, right) => right.taken - left.taken);

    /**
     * Free money is what is left of the spend once the goals' share is named.
     *
     * Subtracted rather than measured: `goalImpact` already resolved exactly
     * what the goals gave up, and re-deriving the free part from claims would
     * let the two figures drift apart on rounding — the block would then say
     * the money came from somewhere it did not.
     *
     * Only the COVERED part is split, so the three parts sum to what actually
     * left the wallets; the shortfall stays in `uncovered`, which is a
     * different fact and already has its own line.
     */
    const covered = Math.max(0, amount - drain.uncovered);
    // Proceeds only count as a source up to what the spend actually took.
    const fromSale = wallets.reduce((sum, wallet) => sum + wallet.fromSale, 0);
    const fundingSource: WhatIfFundingSource = {
      fromSale,
      free: Math.max(
        0,
        covered -
          fromSale -
          goalImpact.totalPaceReduction -
          goalImpact.totalSetAsideReduction,
      ),
      fromPace: goalImpact.totalPaceReduction,
      fromSetAside: goalImpact.totalSetAsideReduction,
      wallets,
    };

    /**
     * What the spend needs versus what is usable today. Measured from the same
     * map the spend is drained from, so this and `uncovered` cannot disagree.
     */
    // Wallets on their own, before any sale — `shortfall` adds the proceeds
    // back in, so the two together say "had this much, raised this much more".
    const liquidAvailable = [...walletsBefore.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    /**
     * Measured against the money available AFTER the sale: once the household
     * has raised the cash, saying they are still short of it is simply wrong,
     * and it is what keeps the funding CTA on screen after it has been used.
     */
    const liquidity: WhatIfLiquidity = {
      liquidAvailable,
      shortfall: Math.max(
        0,
        amount - liquidAvailable - (appliedSale?.amount ?? 0),
      ),
    };

    /**
     * What could be sold to close a shortfall — offered, never recommended.
     * Each option carries what the goals hold of it, so the cost of selling is
     * visible before the household commits to it.
     */
    const fundingOptions: WhatIfFundingOption[] =
      liquidity.shortfall > 0
        ? await this.fundingOptions(householdId, input)
        : [];

    const afterSale =
      afterSaleForecast && afterSaleFlexible
        ? side(
            afterSaleForecast,
            afterSaleFlexible,
            afterGoalResult?.projection ?? null,
          )
        : null;

    return {
      householdId,
      asOfDate,
      horizonDays,
      input: payload,
      obligationsCovered: answerForecast.obligationsCovered,
      before,
      after,
      liquidity,
      fundingOptions,
      assetSale: appliedSale
        ? {
            lines: appliedSale.lines.map((line) => {
              const soldAsset = soldAssets.find(
                (asset) => asset.assetId === line.assetId,
              );
              return {
                assetId: line.assetId,
                name: soldAsset?.name ?? line.assetId,
                amount: line.amount,
                assetValueBefore: soldAsset?.value ?? 0,
                assetValueAfter: (soldAsset?.value ?? 0) - line.amount,
              };
            }),
            amount: appliedSale.amount,
            // No fee on a hypothetical; kept distinct so adding one later
            // does not change what `amount` means.
            netProceeds: appliedSale.amount,
            /**
             * `null` receiving id becomes the sentinel: the client renders its
             * own label for money that sits in no account, since the backend
             * emits no localized string (§3).
             */
            receivingAssetId:
              appliedSale.receivingAssetId ?? UNASSIGNED_WALLET_ID,
            receivingName: appliedSale.receivingAssetId
              ? (walletNames.get(appliedSale.receivingAssetId) ??
                appliedSale.receivingAssetId)
              : UNASSIGNED_WALLET_ID,
          }
        : null,
      afterSale,
      deltaWithSale: afterSale
        ? {
            flexibleMoneyToday:
              afterSale.flexibleMoneyToday - after.flexibleMoneyToday,
            lowestProjectedBalance:
              afterSale.lowestProjectedBalance - after.lowestProjectedBalance,
          }
        : null,
      goalImpact: { ...goalImpact, uncovered: drain.uncovered },
      fundingSource,
      /**
       * WHICH bills stop being payable — not just that something does.
       *
       * `obligationsCovered: false` is enough to colour a badge and useless for
       * deciding anything: what-if exists to answer "what happens if I spend
       * this", and "one of your bills stops being payable" is only an answer
       * once it names the bill and the date.
       */
      newlyAtRisk: findNewlyAtRisk(
        beforeForecast,
        // The world the household is looking at. With a sale applied that is
        // the after-SALE forecast: reading the sale-less one reported bills as
        // broken by a shortfall the proceeds had already covered, and printed
        // a running balance that ignored the money raised.
        answerForecast,
      ),
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

  /**
   * Assets the household could sell to fund a spend, biggest first.
   *
   * Read off the bundle the forecast already loaded — it carries every active
   * asset, not just the liquid ones — so this costs no extra query.
   */
  private async fundingOptions(
    householdId: string,
    input: ForecastInput,
  ): Promise<WhatIfFundingOption[]> {
    const sellable = input.assets.filter(
      (asset) => isSellableForecastAsset(asset) && asset.value > 0,
    );
    if (sellable.length === 0) {
      return [];
    }

    const claims = await this.goalsService.goalClaimsByWallet(
      householdId,
      new Map(sellable.map((asset) => [asset.assetId, asset.value])),
    );

    return sellable
      .map((asset) => ({
        assetId: asset.assetId,
        name: asset.name,
        type: asset.type,
        value: asset.value,
        liquidity: asset.liquidity as 'not_immediately_usable' | 'long_term',
        goalClaimedAmount: claims.get(asset.assetId)?.amount ?? 0,
      }))
      .sort((left, right) => right.value - left.value);
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
