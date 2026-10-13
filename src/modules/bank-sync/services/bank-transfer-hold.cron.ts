import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BANK_SYNC_REPOSITORY } from '../repositories/bank-sync.repository.interface';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';
import { BankIngestService } from './bank-ingest.service';

const GRACE_MS = 30 * 1000;
const STALE_RECEIVED_MS = 5 * 60 * 1000;
const BATCH = 50;

/** Releases held OUT legs whose in-process timer was lost, and recovers abandoned ingests. See memory/bank-sync.md. */
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
          .catch((error: unknown) => this.fail('hold sweep', id, error));
      }
      const stale = await this.repo.findStaleReceived(
        new Date(now.getTime() - STALE_RECEIVED_MS),
        BATCH,
      );
      for (const { id, householdId } of stale) {
        await this.ingest
          .recoverStale(householdId, id)
          .catch((error: unknown) => this.fail('stale recovery', id, error));
      }
      if (held.length) this.logger.log(`bank holds released=${held.length}`);
      if (stale.length)
        this.logger.warn(`bank stale recovered=${stale.length}`);
      return held.length + stale.length;
    } finally {
      this.running = false;
    }
  }

  private fail(step: string, id: string, error: unknown): void {
    this.logger.error(
      `bank ${step} failed id=${id}: ${(error as Error).message}`,
    );
  }
}
