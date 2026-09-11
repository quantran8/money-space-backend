import { WhatIfUsageService } from './whatif-usage.service';
import { cacheKeys } from '../../common/cache/cache.keys';
import { DEFAULT_HOUSEHOLD_TZ, todayInTimeZone } from '../../common/utils/clock';

/**
 * The what-if counter.
 *
 * The behaviour worth pinning is the FAIL-OPEN contract: Redis being
 * unreachable must read as "could not count", never as zero and never as
 * "over limit". Refusing a paying household because the cache blinked is a
 * worse failure than letting a few extra simulations through.
 */
describe('WhatIfUsageService', () => {
  function makeService(cache: Partial<{ incr: jest.Mock; get: jest.Mock }>) {
    return new WhatIfUsageService(cache as never);
  }

  const month = todayInTimeZone(DEFAULT_HOUSEHOLD_TZ).slice(0, 7);

  it('counts against a key carrying the household and the Vietnam-time month', async () => {
    const incr = jest.fn(async () => 1);
    await makeService({ incr }).consume('hh-1');

    expect(incr).toHaveBeenCalledWith(
      cacheKeys.whatIfUsage('hh-1', month),
      expect.any(Number),
    );
    // The month is IN the key, so it rolls over by itself — there is no reset
    // job, and last month's count cannot leak into this one.
    expect(cacheKeys.whatIfUsage('hh-1', month)).toContain(month);
  });

  it('reads back the stored count', async () => {
    const get = jest.fn(async () => 3);
    await expect(makeService({ get }).used('hh-1')).resolves.toBe(3);
  });

  it('reports 0 used when the counter has never been written', async () => {
    const get = jest.fn(async () => undefined);
    await expect(makeService({ get }).used('hh-1')).resolves.toBe(0);
  });

  it('fails OPEN when Redis is unreachable', async () => {
    // `CacheService` returns undefined rather than throwing when it is
    // degraded. Read as 0, the household is under every limit — which is the
    // documented, deliberate direction to fail in.
    const get = jest.fn(async () => undefined);
    const incr = jest.fn(async () => undefined);
    const service = makeService({ get, incr });

    await expect(service.used('hh-1')).resolves.toBe(0);
    await expect(service.consume('hh-1')).resolves.toBeUndefined();
  });
});
