import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../database/prisma/prisma.service';

const logger = new Logger('AdvisoryLock');

/** Stable 32-bit key (FNV-1a) so callers name a lock instead of picking a number. */
export function advisoryLockKey(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * Run `work` only if this process wins a cluster-wide Postgres advisory lock;
 * otherwise return `undefined`.
 *
 * Advisory only — it reduces duplicate effort, it is not exactly-once, so
 * `work` must still be safe to run twice. Rationale for Postgres over Redis is
 * in `memory/market-data.md`.
 */
export async function withAdvisoryLock<T>(
  prisma: PrismaService,
  name: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const key = advisoryLockKey(name);
  const client = prisma.client();

  let acquired = false;
  try {
    const rows = await client.$queryRawUnsafe<Array<{ ok: boolean }>>(
      `SELECT pg_try_advisory_lock(${key}) AS ok`,
    );
    acquired = rows[0]?.ok === true;
  } catch (error) {
    // Can't verify exclusivity → don't claim it; the job retries next tick.
    logger.error(
      `Could not acquire advisory lock "${name}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }

  if (!acquired) return undefined;

  try {
    return await work();
  } finally {
    try {
      await client.$queryRawUnsafe(`SELECT pg_advisory_unlock(${key})`);
    } catch (error) {
      // Not fatal: the lock dies with the connection anyway.
      logger.warn(
        `Could not release advisory lock "${name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
