import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  BankEventStatus,
  BankNotificationEvent,
} from '../entities/bank-sync.entity';
import { BANK_SYNC_REPOSITORY } from '../repositories/bank-sync.repository.interface';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';
import { BankIngestService } from './bank-ingest.service';
import { BankPostingService, type PostSettle } from './bank-posting.service';
import { moneyEventNote } from '../domain/money-event-note';
import { toWalletDrift, type WalletDrift } from '../domain/wallet-drift';

const ALL_STATUSES: readonly BankEventStatus[] = [
  'RECEIVED',
  'PARSE_FAILED',
  'UNMAPPED',
  'REVIEW',
  'PROCESSED',
  'DUPLICATE',
  'FAILED',
  'IGNORED',
];
const OPEN: BankEventStatus[] = [
  'UNMAPPED',
  'REVIEW',
  'PARSE_FAILED',
  'FAILED',
];
const RESOLVABLE: ReadonlySet<BankEventStatus> = new Set([
  ...OPEN,
  'DUPLICATE',
]);
const PAGE_MAX = 100;

export interface ResolveEventDto {
  action?: unknown;
  assetId?: unknown;
  cashflowEventId?: unknown;
}

@Injectable()
export class BankEventsService {
  constructor(
    @Inject(BANK_SYNC_REPOSITORY)
    private readonly repo: BankSyncRepository,
    private readonly ingest: BankIngestService,
    private readonly posting: BankPostingService,
  ) {}

  async list(
    householdId: string,
    query: { status?: string; cursor?: string; limit?: string },
  ) {
    const statuses = parseStatuses(query.status);
    const cursor = query.cursor ? new Date(query.cursor) : null;
    if (cursor && Number.isNaN(cursor.getTime())) {
      throw new BadRequestException('cursor must be an ISO timestamp.');
    }
    const limit = Math.min(Math.max(Number(query.limit) || 30, 1), PAGE_MAX);
    const items = await this.repo.listEvents(
      householdId,
      statuses,
      cursor,
      limit,
    );
    const views = items.map(toView);
    return {
      items: views,
      nextCursor:
        items.length === limit ? views[views.length - 1].receivedAt : null,
    };
  }

  async counts(householdId: string) {
    const counts = await this.repo.countOpenByStatus(householdId);
    const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    return { counts, total };
  }

  async get(householdId: string, id: string) {
    return toView(await this.mustFind(householdId, id));
  }

  /** User decision from the inbox; idempotent once the event is settled. */
  async resolve(
    householdId: string,
    userId: string,
    id: string,
    dto: ResolveEventDto,
  ) {
    const event = await this.mustFind(householdId, id);
    if (dto.action === 'ignore') {
      if (event.status === 'IGNORED') return toView(event);
      if (!RESOLVABLE.has(event.status)) {
        throw new ConflictException(`Bank event is ${event.status}.`);
      }
      await this.repo.updateEvent(id, {
        status: 'IGNORED',
        statusReason: 'USER_IGNORED',
        processedAt: new Date(),
        processedById: userId,
      });
      return this.get(householdId, id);
    }
    if (dto.action === 'post' || dto.action === 'replace_manual') {
      if (dto.assetId !== undefined && typeof dto.assetId !== 'string') {
        throw new BadRequestException('assetId must be a string.');
      }
      if (
        dto.cashflowEventId !== undefined &&
        typeof dto.cashflowEventId !== 'string'
      ) {
        throw new BadRequestException('cashflowEventId must be a string.');
      }
      if (dto.action === 'replace_manual' && !dto.cashflowEventId) {
        throw new BadRequestException('cashflowEventId is required.');
      }
      const settle: PostSettle | undefined = !dto.cashflowEventId
        ? undefined
        : dto.action === 'replace_manual'
          ? { kind: 'replace_manual', cashflowEventId: dto.cashflowEventId }
          : {
              kind: 'link',
              cashflowEventId: dto.cashflowEventId,
              via: 'manual_link',
            };
      await this.posting.post(householdId, id, userId, dto.assetId, settle);
      return this.get(householdId, id);
    }
    throw new BadRequestException(
      'action must be post, replace_manual or ignore.',
    );
  }

  /** Read-only: never applied automatically. See memory/cashflow-settlement.md. */
  async walletDrift(householdId: string) {
    const observations =
      await this.repo.findLatestBalanceObservations(householdId);
    return observations
      .map(toWalletDrift)
      .filter((drift): drift is WalletDrift => drift !== null);
  }

  async reparse(householdId: string, userId: string, id: string) {
    const event = await this.mustFind(householdId, id);
    if (!RESOLVABLE.has(event.status)) {
      throw new ConflictException(`Bank event is ${event.status}.`);
    }
    if (!event.rawPayloadCiphertext) {
      throw new ConflictException(
        'The original notification is no longer kept.',
      );
    }
    await this.ingest.reparse(event, userId);
    return this.get(householdId, id);
  }

  private async mustFind(
    householdId: string,
    id: string,
  ): Promise<BankNotificationEvent> {
    const event = await this.repo.findEvent(householdId, id);
    if (!event) throw new NotFoundException('Bank event not found.');
    return event;
  }
}

function parseStatuses(raw: string | undefined): BankEventStatus[] {
  if (!raw) return OPEN;
  if (raw === 'all') return [...ALL_STATUSES];
  const parts = raw.split(',').map((s) => s.trim().toUpperCase());
  const bad = parts.find(
    (s) => !(ALL_STATUSES as readonly string[]).includes(s),
  );
  if (bad) throw new BadRequestException(`Unknown status "${bad}".`);
  return parts as BankEventStatus[];
}

function toView(e: BankNotificationEvent) {
  return {
    id: e.id,
    status: e.status,
    statusReason: e.statusReason,
    providerCode: e.providerCode,
    appName: e.appName,
    last4: e.identifierLast4,
    amount: e.amountMinor,
    direction: e.direction,
    reportedBalance: e.reportedBalanceMinor,
    transactionAt: e.transactionAt?.toISOString() ?? null,
    notificationAt: e.notificationAt?.toISOString() ?? null,
    timeSource: e.timeSource,
    receivedAt: e.receivedAt.toISOString(),
    processedAt: e.processedAt?.toISOString() ?? null,
    sourceId: e.sourceId,
    matchedAssetId: e.matchedAssetId,
    moneyEventId: e.moneyEventId,
    note: moneyEventNote(e.providerCode, e.description),
    suggestedCashflowEventId: e.suggestedCashflowEventId,
    matchStatus: e.matchStatus,
    matchReason: e.matchReason,
    canReparse: e.rawPayloadCiphertext !== null,
  };
}
