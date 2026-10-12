import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isUniqueViolation } from '../../../common/repositories/prisma-errors';
import { bankSyncConfig } from '../../../config/bank-sync.config';
import { PrismaService } from '../../../database/prisma/prisma.service';
import type {
  BankExternalSource,
  BankPostingMode,
} from '../entities/bank-sync.entity';
import {
  identifierHmac,
  last4,
  normalizeAccountNumber,
} from '../domain/identifier-hmac';
import { isPostableWallet } from '../domain/wallet';
import { isProviderCode } from '../parsers/parser-registry';
import { BANK_SYNC_REPOSITORY } from '../repositories/bank-sync.repository.interface';
import type {
  BankSyncRepository,
  SourceWithLink,
} from '../repositories/bank-sync.repository.interface';
import { BankIngestService } from './bank-ingest.service';

const LABEL_MAX = 60;
const POSTING_MODES: readonly BankPostingMode[] = ['REVIEW', 'AUTO'];

export interface CreateSourceDto {
  providerCode?: unknown;
  accountNumber?: unknown;
  displayLabel?: unknown;
}

export interface LinkSourceDto {
  assetId?: unknown;
  postingMode?: unknown;
}

@Injectable()
export class BankSourcesService {
  constructor(
    @Inject(BANK_SYNC_REPOSITORY)
    private readonly repo: BankSyncRepository,
    private readonly prisma: PrismaService,
    private readonly ingest: BankIngestService,
  ) {}

  /** Idempotent: the same account twice returns the existing source. */
  async create(householdId: string, userId: string, dto: CreateSourceDto) {
    const key = bankSyncConfig.hmacKey;
    if (!key)
      throw new ServiceUnavailableException('Bank sync is not configured.');
    if (!isProviderCode(dto.providerCode)) {
      throw new BadRequestException('Unsupported providerCode.');
    }
    const normalized =
      typeof dto.accountNumber === 'string'
        ? normalizeAccountNumber(dto.accountNumber)
        : null;
    if (!normalized) {
      throw new BadRequestException(
        'accountNumber must be the full account number.',
      );
    }
    const hmac = identifierHmac(key, dto.providerCode, normalized);

    const existing = await this.repo.findSourceByIdentity(
      householdId,
      dto.providerCode,
      hmac,
    );
    if (existing) return this.view(householdId, existing.id);

    const source: BankExternalSource = {
      id: this.repo.createId(),
      householdId,
      createdById: userId,
      sourceType: 'BANK_ACCOUNT',
      providerCode: dto.providerCode,
      identifierHmac: hmac,
      identifierLast4: last4(normalized),
      displayLabel: label(dto.displayLabel),
      status: 'ACTIVE',
      createdAt: new Date(),
    };
    try {
      await this.repo.insertSource(source);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.repo.findSourceByIdentity(
        householdId,
        dto.providerCode,
        hmac,
      );
      if (raced) return this.view(householdId, raced.id);
      throw error;
    }
    return this.view(householdId, source.id);
  }

  async list(householdId: string) {
    const items = await this.repo.listSources(householdId);
    return { items: items.map(toView) };
  }

  async update(
    householdId: string,
    id: string,
    dto: { displayLabel?: unknown; status?: unknown },
  ) {
    await this.mustFind(householdId, id);
    const patch: {
      displayLabel?: string | null;
      status?: 'ACTIVE' | 'DISABLED';
    } = {};
    if (dto.displayLabel !== undefined)
      patch.displayLabel = label(dto.displayLabel);
    if (dto.status !== undefined) {
      if (dto.status !== 'ACTIVE' && dto.status !== 'DISABLED') {
        throw new BadRequestException('status must be ACTIVE or DISABLED.');
      }
      patch.status = dto.status;
    }
    await this.repo.updateSource(householdId, id, patch);
    return this.view(householdId, id);
  }

  /** Same wallet → only the mode changes; another wallet → close + reopen. */
  async link(
    householdId: string,
    userId: string,
    id: string,
    dto: LinkSourceDto,
  ) {
    const source = await this.mustFind(householdId, id);
    const mode = dto.postingMode ?? 'REVIEW';
    if (!POSTING_MODES.includes(mode as BankPostingMode)) {
      throw new BadRequestException('postingMode must be REVIEW or AUTO.');
    }
    if (typeof dto.assetId !== 'string') {
      throw new BadRequestException('assetId is required.');
    }
    const wallet = await this.repo.findWallet(householdId, dto.assetId);
    if (!isPostableWallet(wallet)) {
      throw new BadRequestException(
        'Only an active cash or bank wallet can be linked.',
      );
    }
    if (mode === 'AUTO' && source.status !== 'ACTIVE') {
      throw new BadRequestException('A disabled source cannot auto-post.');
    }

    await this.prisma.runInTransaction(async () => {
      const open = await this.repo.findOpenLink(source.id);
      if (open && open.assetId === wallet.id) {
        if (open.postingMode !== mode) {
          await this.repo.updateLinkMode(open.id, mode as BankPostingMode);
        }
        return;
      }
      const now = new Date();
      await this.repo.closeOpenLink(source.id, now);
      await this.repo.insertLink({
        id: this.repo.createId(),
        householdId,
        externalSourceId: source.id,
        assetId: wallet.id,
        postingMode: mode as BankPostingMode,
        validFrom: now,
        validTo: null,
        createdById: userId,
      });
    });

    const reprocessed = await this.ingest.reprocessUnmapped(
      householdId,
      source.providerCode,
      source.identifierHmac,
      userId,
    );
    return { ...(await this.view(householdId, source.id)), reprocessed };
  }

  async unlink(householdId: string, id: string) {
    const source = await this.mustFind(householdId, id);
    await this.repo.closeOpenLink(source.id, new Date());
    return this.view(householdId, source.id);
  }

  private async mustFind(householdId: string, id: string) {
    const source = await this.repo.findSource(householdId, id);
    if (!source) throw new NotFoundException('Bank source not found.');
    return source;
  }

  private async view(householdId: string, id: string) {
    const items = await this.repo.listSources(householdId);
    const found = items.find((s) => s.id === id);
    if (!found) throw new NotFoundException('Bank source not found.');
    return toView(found);
  }
}

function label(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string')
    throw new BadRequestException('displayLabel must be a string.');
  const trimmed = value.trim();
  if (trimmed.length > LABEL_MAX) {
    throw new BadRequestException(
      `displayLabel must be at most ${LABEL_MAX} characters.`,
    );
  }
  return trimmed || null;
}

// Never exposes the HMAC; last4 is the only account hint that leaves the server.
function toView(s: SourceWithLink) {
  return {
    id: s.id,
    providerCode: s.providerCode,
    sourceType: s.sourceType,
    last4: s.identifierLast4,
    displayLabel: s.displayLabel,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    link: s.openLink
      ? {
          id: s.openLink.id,
          assetId: s.openLink.assetId,
          assetName: s.openLink.assetName,
          postingMode: s.openLink.postingMode,
          validFrom: s.openLink.validFrom.toISOString(),
        }
      : null,
  };
}
