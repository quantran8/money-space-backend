import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BANK_SYNC_REPOSITORY } from '../repositories/bank-sync.repository.interface';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';
import { BankIngestService } from './bank-ingest.service';

const GRACE_MS = 30 * 1000;
const BATCH = 50;

/** Releases held OUT legs whose in-process timer was lost. See memory/bank-sync.md. */
@Injectable()
export class BankTransferHoldCron {
  private readonly logger = new Logger(BankTransferHoldCron.name);
  private running = false;

  constructor(
    @Inject(BANK_SYNC_REPOSITORY)
    private readonly repo: BankSyncRepository,
    private readonly ingest: BankIngestService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweep(): Promise<void> {
    if (process.env.BANK_SYNC_HOLD_CRON_ENABLED === 'false') return;
    await this.run();
  }

  async run(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const held = await this.repo.findHeldEvents(
        new Date(now.getTime() - GRACE_MS),
        BATCH,
      );
      for (const { id, householdId } of held) {
        await this.ingest
          .releaseHeld(householdId, id)
          .catch((error: unknown) =>
            this.logger.error(
              `bank hold sweep failed id=${id}: ${(error as Error).message}`,
            ),
          );
      }
      if (held.length) this.logger.log(`bank holds released=${held.length}`);
      return held.length;
    } finally {
      this.running = false;
    }
  }
}
