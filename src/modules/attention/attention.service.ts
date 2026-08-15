import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { todayInTimeZone } from '../../common/utils/clock';
import { freshnessOf } from '../../common/utils/freshness';
import { computeFlexibleMoney } from '../forecast/domain/flexible-money';
import { runForecast } from '../forecast/domain/forecast';
import { ForecastService } from '../forecast/forecast.service';
import {
  deriveAttentionItems,
  derivedAttentionId,
  type DerivedAttentionItem,
  type DerivedAttentionRuleCode,
} from './domain/attention-rules';
import type {
  AttentionItemView,
  StoredAttentionItem,
} from './entities/attention-item.entity';
import { ATTENTION_REPOSITORY } from './repositories/attention.repository.interface';
import type {
  AttentionRepository,
  DismissalTombstone,
} from './repositories/attention.repository.interface';

/** Horizon used for the derived signals. Matches the Home screen's default. */
const ATTENTION_HORIZON_DAYS = 30;

/** The derived signals a member is allowed to dismiss. */
const DISMISSIBLE_RULE_CODES: readonly DerivedAttentionRuleCode[] = [
  'cashflow_required_due_soon',
  'cashflow_overdue',
  'low_projected_balance',
  'reserve_at_risk',
  'stale_data',
];

/**
 * Attention items (spec §29) — the merge point between two genuinely different
 * kinds of signal.
 *
 * **Derived** signals describe the household's situation right now. They are
 * recomputed on every read from the forecast bundle and never written. See
 * `domain/attention-rules.ts` for why persisting them would be a bug.
 *
 * **Stored** signals are point-in-time observations that cannot be recomputed
 * later — someone flagged a money event, an asset moved sharply between two
 * snapshots. Those are facts about a moment, so a row is the right home.
 *
 * A read returns `stored ∪ derived`, minus any derived signal the household has
 * dismissed. The dismissal itself is stored as a tombstone: it is a decision the
 * household made, which is exactly the kind of thing that deserves a row.
 */
@Injectable()
export class AttentionService {
  constructor(
    @Inject(ATTENTION_REPOSITORY)
    private readonly attentionRepository: AttentionRepository,
    private readonly forecast: ForecastService,
  ) {}

  async listAttentionItems(householdId: string): Promise<{
    householdId: string;
    items: AttentionItemView[];
    total: number;
    storedCount: number;
    derivedCount: number;
  }> {
    // The household row is real input here (`updateFrequency` drives staleness),
    // not an access check — the guard already did that — so it loads alongside
    // the rest instead of in front of it.
    const [household, stored, dismissals, input] = await Promise.all([
      this.attentionRepository.assertHousehold(householdId),
      this.attentionRepository.findOpenStoredItems(householdId),
      this.attentionRepository.findDismissals(householdId),
      this.forecast.loadInput(householdId, ATTENTION_HORIZON_DAYS),
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

    const derived = deriveAttentionItems({
      asOfDate: input.asOfDate,
      forecast,
      flexible,
      staleAssets,
    });

    const visibleDerived = derived.filter(
      (item) => !this.isDismissed(item, dismissals),
    );

    const items: AttentionItemView[] = [
      ...visibleDerived.map((item) => this.toDerivedView(item)),
      ...stored.map((item) => this.toStoredView(item)),
    ].sort(this.byUrgencyThenRecency);

    return {
      householdId,
      items,
      total: items.length,
      storedCount: stored.length,
      derivedCount: visibleDerived.length,
    };
  }

  /**
   * Flag something by hand (§29 `user_flagged`). A member saying "let's talk
   * about this" is a decision, not a computed condition — so it is stored.
   */
  async flagAttentionItem(
    householdId: string,
    payload: {
      title: string;
      reason?: string;
      level?: 'normal' | 'important' | 'urgent';
      relatedObjectType?: StoredAttentionItem['relatedObjectType'];
      relatedObjectId?: string;
    },
    userId?: string | null,
  ) {
    const title = payload.title?.trim();
    if (!title) {
      throw new BadRequestException('title is required');
    }

    const id = this.attentionRepository.createId('attention-item');
    await this.attentionRepository.insertItem({
      id,
      householdId,
      title,
      reason: payload.reason?.trim() || null,
      // `money_event_flagged` when it points at a money event, so the client can
      // tell "we flagged this transaction" from a free-floating note.
      ruleCode:
        payload.relatedObjectType === 'money_event'
          ? 'money_event_flagged'
          : 'user_flagged',
      level: payload.level ?? 'normal',
      amount: null,
      relatedObjectType: payload.relatedObjectType ?? null,
      relatedObjectId: payload.relatedObjectId ?? null,
      createdById: userId ?? null,
    });

    return { id, householdId, title, status: 'open' as const };
  }

  async markSeen(householdId: string, itemId: string, userId?: string | null) {
    await this.ensureStoredItem(householdId, itemId);
    await this.attentionRepository.markSeen(itemId, userId ?? null);
    return { itemId, status: 'seen' as const };
  }

  async markResolved(
    householdId: string,
    itemId: string,
    userId?: string | null,
  ) {
    await this.ensureStoredItem(householdId, itemId);
    await this.attentionRepository.markResolved(itemId, userId ?? null);
    return { itemId, status: 'resolved' as const };
  }

  async markDismissed(
    householdId: string,
    itemId: string,
    userId?: string | null,
  ) {
    await this.ensureStoredItem(householdId, itemId);
    await this.attentionRepository.markDismissed(itemId, userId ?? null);
    return { itemId, status: 'dismissed' as const };
  }

  /**
   * Dismiss a DERIVED signal.
   *
   * There is no row to update — the signal only exists as a computation — so
   * this writes a tombstone carrying the rule code and (when the signal is
   * about one) the related object. Subsequent reads suppress the match.
   *
   * `title` holds the rule code rather than a sentence: a tombstone is never
   * rendered, and putting localized text in it would be copy the backend owns.
   */
  async dismissDerived(
    householdId: string,
    payload: { ruleCode: string; relatedObjectId?: string | null },
    userId?: string | null,
  ) {
    const ruleCode = payload.ruleCode as DerivedAttentionRuleCode;
    if (!DISMISSIBLE_RULE_CODES.includes(ruleCode)) {
      throw new BadRequestException(
        `ruleCode must be one of ${DISMISSIBLE_RULE_CODES.join(', ')}`,
      );
    }

    const relatedObjectId = payload.relatedObjectId ?? null;

    // Dismissing twice is a no-op, not an error: a double-tap on a phone must
    // not surface a failure for something that already reached the goal state.
    const existing = await this.attentionRepository.findDismissals(householdId);
    const already = existing.some(
      (t) => t.ruleCode === ruleCode && t.relatedObjectId === relatedObjectId,
    );
    if (already) {
      return {
        householdId,
        ruleCode,
        relatedObjectId,
        dismissed: true,
        alreadyDismissed: true,
      };
    }

    const id = this.attentionRepository.createId('attention-item');
    await this.attentionRepository.insertItem({
      id,
      householdId,
      title: ruleCode,
      reason: null,
      ruleCode,
      status: 'dismissed',
      relatedObjectType: this.relatedTypeFor(ruleCode),
      relatedObjectId,
      createdById: userId ?? null,
    });

    return {
      householdId,
      ruleCode,
      relatedObjectId,
      dismissed: true,
      alreadyDismissed: false,
    };
  }

  /**
   * Stored open items only — what a snapshot freezes into `attention_count`.
   *
   * Deliberately excludes derived signals: a snapshot is meant to be
   * reproducible, and a derived count depends on a forecast that will have
   * moved by the time anyone reads the snapshot back.
   */
  countOpenStoredItems(householdId: string): Promise<number> {
    return this.attentionRepository.countOpenStoredItems(householdId);
  }

  // --- internals -----------------------------------------------------------

  private isDismissed(
    item: DerivedAttentionItem,
    dismissals: DismissalTombstone[],
  ): boolean {
    return dismissals.some(
      (t) =>
        t.ruleCode === item.ruleCode &&
        t.relatedObjectId === item.relatedObjectId,
    );
  }

  private relatedTypeFor(ruleCode: DerivedAttentionRuleCode) {
    switch (ruleCode) {
      case 'cashflow_required_due_soon':
      case 'cashflow_overdue':
        return 'cashflow_event' as const;
      case 'stale_data':
        return 'asset' as const;
      default:
        // Household-level signals point at nothing in particular.
        return null;
    }
  }

  private toDerivedView(item: DerivedAttentionItem): AttentionItemView {
    return {
      id: item.id,
      source: 'derived',
      ruleCode: item.ruleCode,
      // No text: the client renders the sentence from `ruleCode` + `params`.
      title: null,
      reason: null,
      level: item.level,
      // A derived signal has no lifecycle of its own — it exists while the
      // condition holds, and stops existing when it clears.
      status: 'open',
      amount: item.amount,
      relatedObjectType: item.relatedObjectType,
      relatedObjectId: item.relatedObjectId,
      params: item.params,
      createdAt: null,
    };
  }

  private toStoredView(item: StoredAttentionItem): AttentionItemView {
    return {
      id: item.id,
      source: 'stored',
      // Pre-v3.1 rows predate `rule_code`; they were all hand-created.
      ruleCode: item.ruleCode ?? 'user_flagged',
      title: item.title,
      reason: item.reason,
      level: item.level,
      status: item.status,
      amount: item.amount,
      relatedObjectType: item.relatedObjectType,
      relatedObjectId: item.relatedObjectId,
      params: {},
      createdAt: item.createdAt,
    };
  }

  private readonly byUrgencyThenRecency = (
    a: AttentionItemView,
    b: AttentionItemView,
  ): number => {
    const rank = { urgent: 0, important: 1, normal: 2 } as const;
    const byLevel = rank[a.level] - rank[b.level];
    if (byLevel !== 0) return byLevel;
    // Derived signals describe right now, so they lead within a level.
    if (a.source !== b.source) return a.source === 'derived' ? -1 : 1;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  };

  private async ensureStoredItem(householdId: string, itemId: string) {
    // Guards the derived ids (`derived:…`) too — they are not database rows, so
    // a PATCH against one must 404 rather than silently do nothing.
    const item = await this.attentionRepository.findStoredItemById(
      householdId,
      itemId,
    );
    if (!item) {
      throw new NotFoundException(`Attention item "${itemId}" was not found`);
    }
    return item;
  }

  /** Today in the household timezone — the only clock read in this service. */
  protected today(): string {
    return todayInTimeZone();
  }

  /** Exposed for tests + the derived-id contract shared with the client. */
  static derivedId = derivedAttentionId;
}
