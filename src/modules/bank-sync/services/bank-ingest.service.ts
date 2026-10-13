import {
  Inject,
  Injectable,
  HttpException,
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
  BankPostingMode,
} from '../entities/bank-sync.entity';
import { identifierHmac, last4 } from '../domain/identifier-hmac';
import { accountCandidates } from '../domain/transfer-counterpart';
import { decryptPayload, encryptPayload } from '../domain/payload-cipher';
import { isPostableWallet } from '../domain/wallet';
import { vnIsoDate } from '../domain/vn-time';
import type { IngestBankNotificationDto } from '../dto/ingest-bank-notification.dto';
import { OUT_UNVERIFIED } from '../parsers/bank-notification-parser';
import type {
  BankNotificationInput,
  ProviderCode,
} from '../parsers/bank-notification-parser';
import {
  SUPPORTED_PROVIDERS,
  isProviderCode,
  parserFor,
  providerForApp,
} from '../parsers/parser-registry';
import { BANK_SYNC_REPOSITORY } from '../repositories/bank-sync.repository.interface';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';
import { BankPostingService } from './bank-posting.service';
import { CashflowMatcherService } from '../../cashflow-events/services/cashflow-matcher.service';
import type { MatchResult } from '../../cashflow-events/domain/note-match';

const MINUTE = 60 * 1000;
const SAME_PAYLOAD_WINDOW = 24 * 60 * MINUTE;
const SIMILAR_WINDOW = 10 * MINUTE;
const LINK_CHANGE_WINDOW = 10 * MINUTE;
const TRANSFER_PAIR_WINDOW = MINUTE;

export interface IngestOutcome {
  /** Null when nothing was stored. */
  eventId: string | null;
  status: BankEventStatus | 'NOT_TRANSACTION';
  replayed: boolean;
}

type StoredOutcome = IngestOutcome & {
  eventId: string;
  status: BankEventStatus;
};

interface TransferContext {
  counterpart: { sourceId: string; postingMode: BankPostingMode } | null;
  peer: BankNotificationEvent | null;
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
    private readonly matcher: CashflowMatcherService,
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

    // Promo/system messages are dropped before any write. See memory/bank-sync.md.
    if (provider && !parserFor(provider).isBalanceMovement(input)) {
      this.logger.log(`bank notification skipped provider=${provider}`);
      return { eventId: null, status: 'NOT_TRANSACTION', replayed: false };
    }

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
      description: null,
      parserVersion: null,
      suggestedCashflowEventId: null,
      matchStatus: null,
      matchReason: null,
      counterpartSourceId: null,
      transferPeerEventId: null,
      status: 'RECEIVED',
      statusReason: null,
      receivedAt: now,
      processedAt: null,
      processedById: null,
      moneyEventId: null,
      moneyEventType: null,
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
      description: noteFromBody(input.body, parsed.accountNumber),
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
    const linked: BankEventPatch = {
      sourceId: source.id,
      matchedAssetId: link.assetId,
    };

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

    const transfer = await this.resolveTransfer(
      event,
      source.id,
      link.assetId,
      at,
    );
    linked.counterpartSourceId = transfer.counterpart?.sourceId ?? null;
    const isTransfer = transfer.counterpart !== null || transfer.peer !== null;
    // A transfer settles no cashflow event.
    const match = isTransfer
      ? null
      : await this.matchNote(event, link.assetId, at);
    Object.assign(linked, {
      suggestedCashflowEventId: match?.cashflowEventId ?? null,
      matchStatus: match?.status ?? null,
      matchReason: match?.reason ?? null,
    });
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
    // The other leg already moved the money; this one only closes the pair.
    if (transfer.peer?.moneyEventType === 'transfer') {
      return this.postLinked(event, linked, opts.actorId, null, settle);
    }
    // The other bank confirmed the amount. See memory/bank-sync.md.
    const parserReview =
      transfer.peer && opts.parserReview === OUT_UNVERIFIED
        ? undefined
        : opts.parserReview;
    if (parserReview) {
      return settle('REVIEW', parserReview, linked);
    }
    if (!opts.allowAuto || link.postingMode !== 'AUTO') {
      return settle('REVIEW', 'MANUAL_MODE', linked);
    }
    if (isTransfer && !(await this.transferMayAutoPost(transfer))) {
      return settle('REVIEW', 'TRANSFER_REVIEW', linked);
    }
    // Posting now would double-count a manual completion. See memory/cashflow-settlement.md.
    if (match?.status === 'replace_manual') {
      return settle('REVIEW', 'MATCH_REPLACE_MANUAL', linked);
    }
    return this.postLinked(event, linked, opts.actorId, match, settle);
  }

  private async postLinked(
    event: BankNotificationEvent,
    linked: BankEventPatch,
    actorId: string,
    match: MatchResult | null,
    settle: (
      s: BankEventStatus,
      r: string,
      x?: BankEventPatch,
    ) => Promise<BankEventStatus>,
  ): Promise<BankEventStatus> {
    await this.repo.updateEvent(event.id, linked);
    try {
      await this.postAuto(event, actorId, match);
      return 'PROCESSED';
    } catch (error) {
      this.logger.error(
        `bank event post failed id=${event.id}: ${(error as Error).message}`,
      );
      return settle('FAILED', 'POST_FAILED', linked);
    }
  }

  /** Counterpart source named in the body, and the other leg if it has arrived. */
  private async resolveTransfer(
    event: BankNotificationEvent,
    sourceId: string,
    walletId: string,
    at: Date,
  ): Promise<TransferContext> {
    if (event.amountMinor === null || !event.direction) {
      return { counterpart: null, peer: null };
    }
    const counterpart = await this.findCounterpart(
      event,
      sourceId,
      walletId,
      at,
    );
    if (event.transferPeerEventId) {
      const peer = await this.repo.findEvent(
        event.householdId,
        event.transferPeerEventId,
      );
      return { counterpart, peer };
    }
    const peer = await this.repo.findTransferPeer({
      householdId: event.householdId,
      eventId: event.id,
      direction: event.direction,
      amountMinor: event.amountMinor,
      sourceId,
      counterpartSourceId: counterpart?.sourceId ?? null,
      from: new Date(at.getTime() - TRANSFER_PAIR_WINDOW),
      to: new Date(at.getTime() + TRANSFER_PAIR_WINDOW),
    });
    if (!peer || !(await this.repo.pairTransfer(event.id, peer.id))) {
      return { counterpart, peer: null };
    }
    return { counterpart, peer: { ...peer, transferPeerEventId: event.id } };
  }

  private async findCounterpart(
    event: BankNotificationEvent,
    sourceId: string,
    walletId: string,
    at: Date,
  ): Promise<TransferContext['counterpart']> {
    const { hmacKey } = keys();
    const hmacs = accountCandidates(event.description ?? '').flatMap((n) =>
      SUPPORTED_PROVIDERS.map((p) => identifierHmac(hmacKey, p, n)),
    );
    const sources = (
      await this.repo.findSourcesByHmacs(event.householdId, hmacs)
    ).filter((s) => s.id !== sourceId);
    if (sources.length !== 1 || sources[0].status !== 'ACTIVE') return null;
    const links = await this.repo.findLinksAt(sources[0].id, at);
    if (links.length !== 1 || links[0].assetId === walletId) return null;
    const wallet = await this.repo.findWallet(
      event.householdId,
      links[0].assetId,
    );
    if (!isPostableWallet(wallet)) return null;
    return { sourceId: sources[0].id, postingMode: links[0].postingMode };
  }

  /** A new transfer touches both wallets, so both links must be AUTO. */
  private async transferMayAutoPost({
    counterpart,
    peer,
  }: TransferContext): Promise<boolean> {
    if (!peer) return counterpart?.postingMode === 'AUTO';
    if (peer.moneyEventId) return true;
    if (peer.status !== 'REVIEW' || peer.statusReason !== OUT_UNVERIFIED) {
      return false;
    }
    if (!peer.sourceId) return false;
    const peerAt = peer.transactionAt ?? peer.notificationAt ?? peer.receivedAt;
    const links = await this.repo.findLinksAt(peer.sourceId, peerAt);
    return links.length === 1 && links[0].postingMode === 'AUTO';
  }

  private async matchNote(
    event: BankNotificationEvent,
    walletId: string,
    at: Date,
  ): Promise<MatchResult | null> {
    if (event.amountMinor === null || !event.direction) return null;
    try {
      return await this.matcher.match(event.householdId, {
        providerCode: event.providerCode,
        description: event.description,
        direction: event.direction,
        walletId,
        txDate: vnIsoDate(at),
      });
    } catch (error) {
      this.logger.error(
        `bank event match failed id=${event.id}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /** Post, settling the matched occurrence; a settle conflict still posts the money. */
  private async postAuto(
    event: BankNotificationEvent,
    actorId: string,
    match: MatchResult | null,
  ) {
    if (match?.status !== 'matched' || !match.cashflowEventId) {
      await this.posting.post(event.householdId, event.id, actorId);
      return;
    }
    try {
      await this.posting.post(event.householdId, event.id, actorId, undefined, {
        kind: 'link',
        cashflowEventId: match.cashflowEventId,
        via: 'auto_note',
        matchRuleId: match.ruleId ?? null,
      });
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      await this.repo.updateEvent(event.id, {
        matchStatus: 'blocked',
        matchReason: 'SETTLE_CONFLICT',
      });
      await this.posting.post(event.householdId, event.id, actorId);
    }
  }

  private async finish(
    event: BankNotificationEvent,
    patch: BankEventPatch & { status: BankEventStatus },
  ): Promise<StoredOutcome> {
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

/** The notification body as the event note, full account number masked to last 4. */
export function noteFromBody(
  body: string,
  accountNumber: string | null,
): string {
  let note = body.normalize('NFC').trim();
  if (accountNumber) {
    // Matches the number even when the bank prints it with spaces or dots.
    const pattern = new RegExp(accountNumber.split('').join('[\\s.-]?'), 'g');
    note = note.replace(pattern, `••${accountNumber.slice(-4)}`);
  }
  return note.slice(0, 3000);
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
