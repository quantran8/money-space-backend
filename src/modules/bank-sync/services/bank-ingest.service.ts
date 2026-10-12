import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { bankSyncConfig } from '../../../config/bank-sync.config';
import type {
  BankEventPatch,
  BankEventStatus,
  BankIngestContext,
  BankNotificationEvent,
} from '../entities/bank-sync.entity';
import { identifierHmac, last4 } from '../domain/identifier-hmac';
import { decryptPayload, encryptPayload } from '../domain/payload-cipher';
import { isPostableWallet } from '../domain/wallet';
import type { IngestBankNotificationDto } from '../dto/ingest-bank-notification.dto';
import type {
  BankNotificationInput,
  ProviderCode,
} from '../parsers/bank-notification-parser';
import {
  isProviderCode,
  parserFor,
  providerForApp,
} from '../parsers/parser-registry';
import { BANK_SYNC_REPOSITORY } from '../repositories/bank-sync.repository.interface';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';
import { BankPostingService } from './bank-posting.service';

const MINUTE = 60 * 1000;
const SAME_PAYLOAD_WINDOW = 24 * 60 * MINUTE;
const SIMILAR_WINDOW = 10 * MINUTE;
const LINK_CHANGE_WINDOW = 10 * MINUTE;

export interface IngestOutcome {
  eventId: string;
  status: BankEventStatus;
  replayed: boolean;
}

interface RouteOptions {
  /** False for anything the user has not seen yet arriving through a back door. */
  allowAuto: boolean;
  actorId: string;
  parserReview?: string;
}

@Injectable()
export class BankIngestService {
  private readonly logger = new Logger(BankIngestService.name);

  constructor(
    @Inject(BANK_SYNC_REPOSITORY)
    private readonly repo: BankSyncRepository,
    private readonly posting: BankPostingService,
  ) {}

  async ingest(
    ctx: BankIngestContext,
    dto: IngestBankNotificationDto,
  ): Promise<IngestOutcome> {
    const { hmacKey } = keys();
    const payloadKey = bankSyncConfig.storeRawPayload
      ? payloadKeyOrThrow()
      : null;
    const now = new Date();
    const provider = providerForApp(dto.app);
    const input: BankNotificationInput = { title: dto.title, body: dto.body };
    const payloadFingerprint = fingerprint(hmacKey, dto);
    const clientEventId =
      dto.clientEventId ??
      derivedClientEventId(
        ctx.credentialId,
        payloadFingerprint,
        dto.notificationAt,
      );

    const event: BankNotificationEvent = {
      id: this.repo.createId(),
      householdId: ctx.householdId,
      userId: ctx.userId,
      ingestCredentialId: ctx.credentialId,
      clientEventId,
      providerCode: provider,
      appName: dto.app.trim().slice(0, 100),
      titleRedacted: redact(dto.title),
      rawPayloadCiphertext: payloadKey
        ? encryptPayload(payloadKey, JSON.stringify(input))
        : null,
      rawExpiresAt: payloadKey
        ? new Date(
            now.getTime() + bankSyncConfig.rawRetentionDays * 24 * 60 * MINUTE,
          )
        : null,
      payloadFingerprint,
      identifierHmac: null,
      identifierLast4: null,
      sourceId: null,
      matchedAssetId: null,
      amountMinor: null,
      direction: null,
      reportedBalanceMinor: null,
      transactionAt: null,
      notificationAt: dto.notificationAt,
      timeSource: null,
      externalReference: null,
      parserVersion: null,
      status: 'RECEIVED',
      statusReason: null,
      receivedAt: now,
      processedAt: null,
      processedById: null,
      moneyEventId: null,
    };

    if (!(await this.repo.insertEvent(event))) {
      const stored = await this.repo.findEventByClientId(
        ctx.credentialId,
        clientEventId,
      );
      return {
        eventId: stored?.id ?? event.id,
        status: stored?.status ?? 'RECEIVED',
        replayed: true,
      };
    }

    // The same notification delivered twice under two UUIDs.
    if (
      event.payloadFingerprint &&
      (await this.repo.existsSamePayload(
        ctx.householdId,
        event.payloadFingerprint,
        new Date(now.getTime() - SAME_PAYLOAD_WINDOW),
        event.id,
      ))
    ) {
      return this.finish(event, {
        status: 'DUPLICATE',
        statusReason: 'SAME_PAYLOAD',
      });
    }

    if (!provider) {
      return this.finish(event, {
        status: 'PARSE_FAILED',
        statusReason: 'APP_NOT_SUPPORTED',
      });
    }

    const status = await this.parseAndRoute(event, input, {
      allowAuto: true,
      actorId: ctx.userId,
    });
    return { eventId: event.id, status, replayed: false };
  }

  /** Re-run the parser over the stored raw payload. Never auto-posts. */
  async reparse(
    event: BankNotificationEvent,
    actorId: string,
  ): Promise<BankEventStatus> {
    const payloadKey = payloadKeyOrThrow();
    if (!event.rawPayloadCiphertext) {
      throw new ServiceUnavailableException('Raw payload has expired.');
    }
    const input = JSON.parse(
      decryptPayload(payloadKey, event.rawPayloadCiphertext),
    ) as BankNotificationInput;
    const provider = event.providerCode ?? providerForApp(event.appName);
    if (!provider) {
      await this.repo.updateEvent(event.id, {
        status: 'PARSE_FAILED',
        statusReason: 'APP_NOT_SUPPORTED',
      });
      return 'PARSE_FAILED';
    }
    return this.parseAndRoute({ ...event, providerCode: provider }, input, {
      allowAuto: false,
      actorId,
    });
  }

  /** After a source is linked: unmapped events move up to REVIEW at most. */
  async reprocessUnmapped(
    householdId: string,
    providerCode: string,
    hmac: string,
    actorId: string,
  ) {
    const events = await this.repo.findUnmappedByIdentifier(
      householdId,
      providerCode,
      hmac,
    );
    for (const event of events) {
      await this.route(event, { allowAuto: false, actorId });
    }
    return events.length;
  }

  private async parseAndRoute(
    event: BankNotificationEvent,
    input: BankNotificationInput,
    opts: RouteOptions,
  ): Promise<BankEventStatus> {
    const provider = event.providerCode as ProviderCode;
    const result = parserFor(provider).parse(input);
    if (!result.ok) {
      return this.finish(event, {
        status: result.status,
        statusReason: result.reason,
        parserVersion: result.parserVersion,
      }).then((o) => o.status);
    }

    const parsed = result.event;
    const { hmacKey } = keys();
    const transactionAt = parsed.transactionAt;
    const patch: BankEventPatch = {
      providerCode: provider,
      amountMinor: parsed.amountMinor,
      direction: parsed.direction,
      reportedBalanceMinor: parsed.reportedBalanceMinor,
      transactionAt,
      timeSource: transactionAt
        ? 'CONTENT'
        : event.notificationAt
          ? 'NOTIFICATION'
          : 'RECEIVED',
      externalReference: parsed.externalReference,
      parserVersion: parsed.parserVersion,
      identifierHmac: parsed.accountNumber
        ? identifierHmac(hmacKey, provider, parsed.accountNumber)
        : null,
      identifierLast4: parsed.accountNumber
        ? last4(parsed.accountNumber)
        : null,
    };
    await this.repo.updateEvent(event.id, patch);
    return this.route(
      { ...event, ...patch },
      {
        ...opts,
        parserReview: result.reviewReason,
      },
    );
  }

  /** Steps 5–8 of the ingest flow in memory/bank-sync.md. */
  private async route(
    event: BankNotificationEvent,
    opts: RouteOptions,
  ): Promise<BankEventStatus> {
    const settle = (
      status: BankEventStatus,
      statusReason: string,
      extra: BankEventPatch = {},
    ) =>
      this.finish(event, { status, statusReason, ...extra }).then(
        (o) => o.status,
      );

    if (
      !event.identifierHmac ||
      !event.providerCode ||
      !isProviderCode(event.providerCode)
    ) {
      return settle('REVIEW', 'ACCOUNT_MISSING');
    }
    const source = await this.repo.findSourceByIdentity(
      event.householdId,
      event.providerCode,
      event.identifierHmac,
    );
    if (!source) {
      return settle('UNMAPPED', 'NO_SOURCE');
    }
    if (source.status !== 'ACTIVE') {
      return settle('REVIEW', 'SOURCE_DISABLED', { sourceId: source.id });
    }

    const at = event.transactionAt ?? event.notificationAt ?? event.receivedAt;
    const links = await this.repo.findLinksAt(source.id, at);
    if (links.length === 0) {
      return settle('UNMAPPED', 'NO_LINK', { sourceId: source.id });
    }
    if (links.length > 1) {
      return settle('REVIEW', 'LINK_AMBIGUOUS', { sourceId: source.id });
    }
    const link = links[0];
    const linked = { sourceId: source.id, matchedAssetId: link.assetId };

    const changedNearby = await this.repo.hasLinkClosedBetween(
      source.id,
      new Date(at.getTime() - LINK_CHANGE_WINDOW),
      new Date(at.getTime() + LINK_CHANGE_WINDOW),
    );
    if (changedNearby) {
      return settle('REVIEW', 'LINK_CHANGED', linked);
    }

    const wallet = await this.repo.findWallet(event.householdId, link.assetId);
    if (!isPostableWallet(wallet)) {
      return settle('REVIEW', 'ASSET_UNAVAILABLE', linked);
    }

    if (event.amountMinor !== null && event.direction) {
      const similar = await this.repo.existsSimilar({
        householdId: event.householdId,
        sourceId: source.id,
        direction: event.direction,
        amountMinor: event.amountMinor,
        from: new Date(at.getTime() - SIMILAR_WINDOW),
        to: new Date(at.getTime() + SIMILAR_WINDOW),
        excludeId: event.id,
      });
      if (similar) {
        return settle('REVIEW', 'POSSIBLE_DUPLICATE', linked);
      }
    }

    if (opts.parserReview) {
      return settle('REVIEW', opts.parserReview, linked);
    }
    if (!opts.allowAuto || link.postingMode !== 'AUTO') {
      return settle('REVIEW', 'MANUAL_MODE', linked);
    }

    await this.repo.updateEvent(event.id, linked);
    try {
      await this.posting.post(event.householdId, event.id, opts.actorId);
      return 'PROCESSED';
    } catch (error) {
      this.logger.error(
        `bank event post failed id=${event.id}: ${(error as Error).message}`,
      );
      return settle('FAILED', 'POST_FAILED', linked);
    }
  }

  private async finish(
    event: BankNotificationEvent,
    patch: BankEventPatch & { status: BankEventStatus },
  ): Promise<IngestOutcome> {
    await this.repo.updateEvent(event.id, patch);
    return { eventId: event.id, status: patch.status, replayed: false };
  }
}

function keys(): { hmacKey: Buffer } {
  const hmacKey = bankSyncConfig.hmacKey;
  if (!hmacKey) {
    throw new ServiceUnavailableException('Bank sync is not configured.');
  }
  return { hmacKey };
}

// Still needed with storage off: rows written before the switch stay decryptable.
function payloadKeyOrThrow(): Buffer {
  const payloadKey = bankSyncConfig.payloadKey;
  if (!payloadKey) {
    throw new ServiceUnavailableException(
      'Bank sync payload key is not configured.',
    );
  }
  return payloadKey;
}

/**
 * A stable id for a Shortcut that sends no clientEventId: the same notification
 * retried maps to the same id. See memory/bank-sync.md.
 */
function derivedClientEventId(
  credentialId: string,
  payloadFingerprint: string,
  notificationAt: Date | null,
): string {
  const hex = createHash('sha256')
    .update(
      `${credentialId}|${payloadFingerprint}|${notificationAt?.toISOString() ?? ''}`,
    )
    .digest('hex');
  // UUID layout with version 8 (custom) and the RFC 4122 variant bits.
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function fingerprint(key: Buffer, dto: IngestBankNotificationDto): string {
  const normalized = [dto.app, dto.title, dto.body]
    .map((part) => part.normalize('NFC').replace(/\s+/g, ' ').trim())
    .join('\u0000');
  return createHmac('sha256', key).update(normalized).digest('hex');
}

/** Masks digit runs that could be an account number. */
function redact(title: string): string | null {
  const trimmed = title.trim().slice(0, 200);
  return trimmed ? trimmed.replace(/\d{6,}/g, (d) => `••${d.slice(-4)}`) : null;
}
