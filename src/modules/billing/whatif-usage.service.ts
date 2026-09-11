import { Injectable } from '@nestjs/common';
import { CacheService } from '../../common/cache/cache.service';
import { cacheKeys, cacheTtl } from '../../common/cache/cache.keys';
import { DEFAULT_HOUSEHOLD_TZ, todayInTimeZone } from '../../common/utils/clock';

/**
 * How many what-ifs a household has run this month.
 *
 * **A Redis counter, not a table** — and that is a deliberate choice, not a
 * shortcut. What-if is a pure read: it writes nothing, deliberately not even a
 * journal entry, and people re-run it constantly while nudging an amount up and
 * down. A row per run would turn the cheapest operation in the app into a
 * write, and the table would grow fastest for the households getting the most
 * value out of it.
 *
 * What is lost if Redis is wiped is one month of counting, worth 0đ. The count
 * cannot be rebuilt from the audit log precisely because what-if writes none —
 * which is itself the right trade: nobody wants "your partner simulated a
 * purchase" in the family journal.
 *
 * Every method FAILS OPEN. `CacheService` returns `undefined` when Redis is
 * unreachable, and that means "could not count", never zero: refusing a
 * household because the cache blinked is a far worse failure than letting a few
 * extra simulations through.
 */
@Injectable()
export class WhatIfUsageService {
  constructor(private readonly cache: CacheService) {}

  /**
   * The calendar month in Vietnam time — where the households are, and the
   * month boundary they would recognise. Using UTC would roll the counter over
   * at 7am local on the first of the month.
   */
  private currentMonth(): string {
    return todayInTimeZone(DEFAULT_HOUSEHOLD_TZ).slice(0, 7);
  }

  /**
   * Count one run, returning the new total. `undefined` when the count is
   * unavailable.
   */
  async consume(householdId: string): Promise<number | undefined> {
    return this.cache.incr(
      cacheKeys.whatIfUsage(householdId, this.currentMonth()),
      cacheTtl.whatIfUsage,
    );
  }

  /** What has been used so far. 0 when nothing is counted yet. */
  async used(householdId: string): Promise<number> {
    // `incr` stores a bare integer rather than a JSON document, which
    // `JSON.parse` in `CacheService.get` reads back as a number — the one
    // shape where the two agree without a wrapper.
    const value = await this.cache.get<number>(
      cacheKeys.whatIfUsage(householdId, this.currentMonth()),
    );
    return typeof value === 'number' ? value : 0;
  }
}
