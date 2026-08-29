import { Inject, Injectable } from '@nestjs/common';
import { todayInTimeZone } from '../../common/utils/clock';
import { freshnessOf } from '../../common/utils/freshness';
import { computeFlexibleMoney } from '../forecast/domain/flexible-money';
import { runForecast } from '../forecast/domain/forecast';
import { ForecastService } from '../forecast/forecast.service';
import {
  deriveAttentionItems,
  derivedAttentionId,
  type DerivedAttentionItem,
} from './domain/attention-rules';
import type { AttentionItemView } from './entities/attention-item.entity';
// A repository, not GoalsService: GoalsModule imports Assets and Forecast, and
// Forecast imports Goals — pulling the service in here would drag that whole
// knot into a module that only needs two plain reads.
import { GOALS_REPOSITORY } from '../goals/repositories/goals.repository.interface';
import type { GoalsRepository } from '../goals/repositories/goals.repository.interface';
import { ATTENTION_REPOSITORY } from './repositories/attention.repository.interface';
import type { AttentionRepository } from './repositories/attention.repository.interface';

/** Horizon used for the derived signals. Matches the Home screen's default. */
const ATTENTION_HORIZON_DAYS = 30;

/**
 * Attention items (spec §29) — signals about the household's situation, all of
 * them DERIVED.
 *
 * Every signal is recomputed on each read from the forecast bundle and nothing
 * is ever written. That is what makes them self-correcting: a signal appears the
 * moment its condition holds and disappears the moment it stops, with no write
 * to keep in step and no row to go stale. See `domain/attention-rules.ts`.
 *
 * The `attention_items` table and its stored/dismiss lifecycle were dropped
 * (2026-08-29): the table had never held a row, and a stored mirror of a
 * computed condition is the denormalization this design exists to avoid.
 */
@Injectable()
export class AttentionService {
  constructor(
    @Inject(ATTENTION_REPOSITORY)
    private readonly attentionRepository: AttentionRepository,
    private readonly forecast: ForecastService,
    @Inject(GOALS_REPOSITORY)
    private readonly goalsRepository: GoalsRepository,
  ) {}

  async listAttentionItems(householdId: string): Promise<{
    householdId: string;
    items: AttentionItemView[];
    total: number;
  }> {
    // The household row is real input here (`updateFrequency` drives staleness),
    // not an access check — the guard already did that — so it loads alongside
    // the rest instead of in front of it.
    const [household, input, goals, allocations] = await Promise.all([
      this.attentionRepository.assertHousehold(householdId),
      this.forecast.loadInput(householdId, ATTENTION_HORIZON_DAYS),
      this.goalsRepository.findFinancialGoalsByHousehold(householdId),
      this.goalsRepository.findAllocationsByHousehold(householdId),
    ]);

    const forecast = runForecast(input);
    const flexible = computeFlexibleMoney(forecast);

    // Staleness is measured against the household's OWN cadence, not a global
    // constant — a household on `manual` never goes stale (see freshness.ts).
    const staleAssets = input.assets
      .map((asset) => ({
        assetId: asset.assetId,
        name: asset.name,
        freshness: freshnessOf(
          input.asOfDate,
          asset.valueUpdatedAt,
          household.updateFrequency,
        ),
      }))
      .filter((entry) => entry.freshness.state === 'stale')
      .map((entry) => ({
        assetId: entry.assetId,
        name: entry.name,
        daysSinceUpdate: entry.freshness.daysSinceUpdate ?? 0,
      }));

    /**
     * Goals with claims behind them but no CONTRIBUTION share among those
     * claims — nothing they can be saved into month to month.
     *
     * Read from `role`, not from the asset's type, because `role` is the
     * household's own answer to "is this wallet feeding the goal, or value it
     * already holds?" and it is the same field the asset delete flow checks
     * when it warns that a goal is about to lose its last wallet. Two places
     * deciding "does this goal have a wallet?" differently is how the warning
     * and the signal would end up disagreeing about the same goal.
     *
     * `findAllocationsByHousehold` already skips claims over deleted assets, so
     * a goal whose only wallet was deleted lands here on the very next read —
     * which is exactly the case this signal exists for.
     */
    const contributionGoalIds = new Set(
      allocations
        .filter((allocation) => allocation.role === 'contribution')
        .map((allocation) => allocation.financialGoalId),
    );
    const claimedGoalIds = new Set(
      allocations.map((allocation) => allocation.financialGoalId),
    );
    const goalsWithoutWallet = goals
      // A goal with NO claims at all is a different situation (nothing behind it
      // yet, rather than nothing to pay into it) and is not this signal's job.
      .filter(
        (goal) =>
          claimedGoalIds.has(goal.id) && !contributionGoalIds.has(goal.id),
      )
      .map((goal) => ({ goalId: goal.id, name: goal.name }));

    // A liquid source holding a negative balance can only be a wallet — nothing
    // else can go below zero (a market position is quantity × price, a property
    // is a valuation), so no asset-type lookup is needed to identify one. Read
    // off the list the forecast already loaded, so this costs no extra query.
    const overdrawnWallets = input.assets
      .filter((asset) => asset.value < 0)
      .map((asset) => ({
        assetId: asset.assetId,
        name: asset.name,
        balance: asset.value,
      }));

    const derived = deriveAttentionItems({
      asOfDate: input.asOfDate,
      forecast,
      flexible,
      staleAssets,
      goalsWithoutWallet,
      overdrawnWallets,
    });

    const items: AttentionItemView[] = derived
      .map((item) => this.toDerivedView(item))
      .sort(this.byUrgency);

    return { householdId, items, total: items.length };
  }

  // --- internals -----------------------------------------------------------

  private toDerivedView(item: DerivedAttentionItem): AttentionItemView {
    return {
      id: item.id,
      ruleCode: item.ruleCode,
      level: item.level,
      amount: item.amount,
      relatedObjectType: item.relatedObjectType,
      relatedObjectId: item.relatedObjectId,
      // No text: the client renders the sentence from `ruleCode` + `params`.
      params: item.params,
    };
  }

  /**
   * Urgency first. Within a level the derivation order stands: it is stable
   * across reads (the rules push in a fixed sequence), which keeps the list from
   * reshuffling under the reader between two identical states.
   */
  private readonly byUrgency = (
    a: AttentionItemView,
    b: AttentionItemView,
  ): number => {
    const rank = { urgent: 0, important: 1, normal: 2 } as const;
    return rank[a.level] - rank[b.level];
  };

  /** Today in the household timezone — the only clock read in this service. */
  protected today(): string {
    return todayInTimeZone();
  }

  /** Exposed for tests + the derived-id contract shared with the client. */
  static derivedId = derivedAttentionId;
}
