import { advisoryLockKey, withAdvisoryLock } from './advisory-lock';
import type { PrismaService } from '../../database/prisma/prisma.service';

function prismaWith(queryRawUnsafe: jest.Mock): PrismaService {
  return {
    client: () => ({ $queryRawUnsafe: queryRawUnsafe }),
  } as unknown as PrismaService;
}

/** The SQL text of the nth call. */
function sqlOf(query: jest.Mock, index: number): string {
  return (query.mock.calls[index] as [string])[0];
}

/** Grants the lock, then records the unlock call. */
function granting() {
  return jest
    .fn()
    .mockResolvedValueOnce([{ ok: true }])
    .mockResolvedValue([]);
}

describe('advisoryLockKey', () => {
  it('is stable for the same name', () => {
    expect(advisoryLockKey('assets:daily-valuation')).toBe(
      advisoryLockKey('assets:daily-valuation'),
    );
  });

  it('differs between names', () => {
    expect(advisoryLockKey('job-a')).not.toBe(advisoryLockKey('job-b'));
  });

  it('stays inside a signed 32-bit range', () => {
    for (const name of ['a', 'assets:daily-valuation', 'x'.repeat(200)]) {
      const key = advisoryLockKey(name);
      expect(Number.isInteger(key)).toBe(true);
      expect(key).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(key).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });
});

describe('withAdvisoryLock', () => {
  it('runs the work and releases the lock when it wins', async () => {
    const query = granting();
    const work = jest.fn().mockResolvedValue('done');

    const result = await withAdvisoryLock(prismaWith(query), 'job', work);

    expect(result).toBe('done');
    expect(work).toHaveBeenCalledTimes(1);
    // Acquire, then release.
    expect(query).toHaveBeenCalledTimes(2);
    expect(sqlOf(query, 1)).toContain('pg_advisory_unlock');
  });

  it('skips the work when another holder has the lock', async () => {
    const query = jest.fn().mockResolvedValue([{ ok: false }]);
    const work = jest.fn();

    const result = await withAdvisoryLock(prismaWith(query), 'job', work);

    expect(result).toBeUndefined();
    expect(work).not.toHaveBeenCalled();
    // Nothing to release — no unlock is issued.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('releases the lock even when the work throws', async () => {
    const query = granting();
    const work = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(
      withAdvisoryLock(prismaWith(query), 'job', work),
    ).rejects.toThrow('boom');

    // A lock left held would block every later run of the job.
    expect(sqlOf(query, 1)).toContain('pg_advisory_unlock');
  });

  it('skips rather than running unguarded when the lock cannot be read', async () => {
    // Claiming exclusivity we could not verify is the one thing this must not
    // do — the job runs again on the next tick anyway.
    const query = jest.fn().mockRejectedValue(new Error('db down'));
    const work = jest.fn();

    const result = await withAdvisoryLock(prismaWith(query), 'job', work);

    expect(result).toBeUndefined();
    expect(work).not.toHaveBeenCalled();
  });

  it('still returns the result when releasing fails', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ ok: true }])
      .mockRejectedValueOnce(new Error('connection lost'));
    const work = jest.fn().mockResolvedValue('done');

    // The lock dies with the connection, so a failed unlock is not fatal.
    await expect(
      withAdvisoryLock(prismaWith(query), 'job', work),
    ).resolves.toBe('done');
  });

  it('locks on the key derived from the name', async () => {
    const query = granting();

    await withAdvisoryLock(prismaWith(query), 'assets:daily-valuation', () =>
      Promise.resolve(1),
    );

    const key = advisoryLockKey('assets:daily-valuation');
    expect(sqlOf(query, 0)).toContain(`pg_try_advisory_lock(${key})`);
  });
});
