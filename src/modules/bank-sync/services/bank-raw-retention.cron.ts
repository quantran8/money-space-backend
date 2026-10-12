import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { withAdvisoryLock } from '../../../common/utils/advisory-lock';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { BANK_SYNC_REPOSITORY } from '../repositories/bank-sync.repository.interface';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';

const BATCH = 500;
const MAX_BATCHES = 20;

/** Drops raw notification ciphertext past retention. See memory/bank-sync.md. */
@Injectable()
export class BankRawRetentionCron {
  private static readonly LOCK_NAME = 'bank-sync:raw-retention';
  private readonly logger = new Logger(BankRawRetentionCron.name);
  private running = false;

  constructor(
    @Inject(BANK_SYNC_REPOSITORY)
    private readonly repo: BankSyncRepository,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('30 3 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async purge(): Promise<void> {
    if (process.env.BANK_SYNC_RETENTION_CRON_ENABLED === 'false') return;
    await this.run();
  }

  async run(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const purged = await withAdvisoryLock(
        this.prisma,
        BankRawRetentionCron.LOCK_NAME,
        async () => {
          let total = 0;
          for (let i = 0; i < MAX_BATCHES; i += 1) {
            const n = await this.repo.purgeExpiredRaw(now, BATCH);
            total += n;
            if (n < BATCH) break;
          }
          return total;
        },
      );
      if (purged) this.logger.log(`bank raw payloads purged=${purged}`);
      return purged ?? 0;
    } finally {
      this.running = false;
    }
  }
}
