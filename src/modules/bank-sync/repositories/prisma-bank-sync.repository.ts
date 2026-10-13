import { Injectable } from '@nestjs/common';
import type {
  BankSourceLink as BankSourceLinkRow,
  Prisma,
} from '@prisma/client';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { isUniqueViolation } from '../../../common/repositories/prisma-errors';
import { uuidv7 } from '../../../common/utils/uuid';
import { PrismaService } from '../../../database/prisma/prisma.service';
import type { BalanceObservation } from '../domain/wallet-drift';
import { TRANSFER_AWAITING_PEER } from '../domain/transfer-counterpart';
import type {
  BankCredential,
  BankEventPatch,
  BankEventStatus,
  BankExternalSource,
  BankNotificationEvent,
  BankPostingMode,
  BankSourceLink,
  BankSourceStatus,
  WalletRef,
} from '../entities/bank-sync.entity';
import type {
  BankDirection,
  ProviderCode,
} from '../parsers/bank-notification-parser';
import type {
  BankSyncRepository,
  SourceWithLink,
} from './bank-sync.repository.interface';

const CREDENTIAL_SELECT = {
  id: true,
  userId: true,
  householdId: true,
  deviceLabel: true,
  tokenPrefix: true,
  status: true,
  expiresAt: true,
  lastUsedAt: true,
  createdAt: true,
  revokedAt: true,
} as const;

const EVENT_INCLUDE = {
  moneyEvent: { select: { id: true, eventType: true } },
} as const;

// A held OUT stays out of the inbox until released. `not` alone would drop NULL reasons.
const NOT_HELD: Prisma.BankNotificationEventWhereInput = {
  OR: [
    { statusReason: null },
    { statusReason: { not: TRANSFER_AWAITING_PEER } },
  ],
};

/** Statuses an inbox still has to act on. */
const OPEN_STATUSES: BankEventStatus[] = [
  'UNMAPPED',
  'REVIEW',
  'PARSE_FAILED',
  'FAILED',
];

@Injectable()
export class PrismaBankSyncRepository
  extends PrismaRepository
  implements BankSyncRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  createId(): string {
    return uuidv7();
  }

  async insertCredential(
    row: BankCredential & { tokenHash: string },
  ): Promise<void> {
    await this.prisma.bankIngestCredential.create({ data: row });
  }

  listCredentials(
    householdId: string,
    userId: string,
  ): Promise<BankCredential[]> {
    return this.prisma.bankIngestCredential.findMany({
      where: { householdId, userId },
      select: CREDENTIAL_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeCredential(
    householdId: string,
    userId: string,
    id: string,
    at: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.bankIngestCredential.updateMany({
      where: { id, householdId, userId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: at },
    });
    return count > 0;
  }

  findCredentialByHash(tokenHash: string): Promise<BankCredential | null> {
    return this.prisma.bankIngestCredential.findUnique({
      where: { tokenHash },
      select: CREDENTIAL_SELECT,
    });
  }

  async touchCredential(id: string, at: Date): Promise<void> {
    await this.prisma.bankIngestCredential.update({
      where: { id },
      data: { lastUsedAt: at },
    });
  }

  async isLiveMember(householdId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.householdMember.findFirst({
      where: {
        householdId,
        userId,
        deletedAt: null,
        household: { deletedAt: null },
      },
      select: { id: true },
    });
    return row !== null;
  }

  async insertSource(row: BankExternalSource): Promise<void> {
    await this.prisma.bankExternalSource.create({
      data: { ...row, updatedAt: row.createdAt },
    });
  }

  findSource(
    householdId: string,
    id: string,
  ): Promise<BankExternalSource | null> {
    return this.prisma.bankExternalSource.findFirst({
      where: { id, householdId },
    });
  }

  findSourceByIdentity(
    householdId: string,
    providerCode: string,
    identifierHmac: string,
  ) {
    return this.prisma.bankExternalSource.findUnique({
      where: {
        householdId_providerCode_identifierHmac: {
          householdId,
          providerCode,
          identifierHmac,
        },
      },
    });
  }

  async listSources(householdId: string): Promise<SourceWithLink[]> {
    const rows = await this.prisma.bankExternalSource.findMany({
      where: { householdId },
      orderBy: { createdAt: 'asc' },
      include: {
        links: {
          where: { validTo: null },
          include: { asset: { select: { name: true } } },
        },
      },
    });
    return rows.map(({ links, ...source }) => {
      const open = links[0];
      return {
        ...source,
        openLink: open
          ? { ...mapLink(open), assetName: open.asset.name }
          : null,
      };
    });
  }

  async updateSource(
    householdId: string,
    id: string,
    patch: { displayLabel?: string | null; status?: BankSourceStatus },
  ): Promise<void> {
    await this.prisma.bankExternalSource.updateMany({
      where: { id, householdId },
      data: patch,
    });
  }

  async findOpenLink(sourceId: string): Promise<BankSourceLink | null> {
    const row = await this.prisma.bankSourceLink.findFirst({
      where: { externalSourceId: sourceId, validTo: null },
    });
    return row ? mapLink(row) : null;
  }

  async findLinksAt(sourceId: string, at: Date): Promise<BankSourceLink[]> {
    const rows = await this.prisma.bankSourceLink.findMany({
      where: {
        externalSourceId: sourceId,
        validFrom: { lte: at },
        OR: [{ validTo: null }, { validTo: { gt: at } }],
      },
    });
    return rows.map(mapLink);
  }

  async hasLinkClosedBetween(
    sourceId: string,
    from: Date,
    to: Date,
  ): Promise<boolean> {
    const row = await this.prisma.bankSourceLink.findFirst({
      where: { externalSourceId: sourceId, validTo: { gte: from, lte: to } },
      select: { id: true },
    });
    return row !== null;
  }

  async closeOpenLink(sourceId: string, at: Date): Promise<void> {
    await this.prisma.bankSourceLink.updateMany({
      where: { externalSourceId: sourceId, validTo: null },
      data: { validTo: at },
    });
  }

  async insertLink(
    row: BankSourceLink & { createdById: string },
  ): Promise<void> {
    await this.prisma.bankSourceLink.create({ data: row });
  }

  async updateLinkMode(linkId: string, mode: BankPostingMode): Promise<void> {
    await this.prisma.bankSourceLink.update({
      where: { id: linkId },
      data: { postingMode: mode },
    });
  }

  findWallet(householdId: string, assetId: string): Promise<WalletRef | null> {
    return this.prisma.asset.findFirst({
      where: { id: assetId, householdId },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        deletedAt: true,
      },
    });
  }

  findSourcesByHmacs(
    householdId: string,
    hmacs: string[],
  ): Promise<BankExternalSource[]> {
    if (hmacs.length === 0) return Promise.resolve([]);
    return this.prisma.bankExternalSource.findMany({
      where: { householdId, identifierHmac: { in: hmacs } },
    });
  }

  async insertEvent(row: BankNotificationEvent): Promise<boolean> {
    const data: Prisma.BankNotificationEventUncheckedCreateInput & {
      moneyEventId?: string | null;
      moneyEventType?: string | null;
    } = { ...row, rawPayloadCiphertext: toBytes(row.rawPayloadCiphertext) };
    delete data.moneyEventId;
    delete data.moneyEventType;
    try {
      await this.prisma.bankNotificationEvent.create({ data });
      return true;
    } catch (error) {
      // Same (credential, clientEventId): a retry of an event already stored.
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async findEventByClientId(credentialId: string, clientEventId: string) {
    const row = await this.prisma.bankNotificationEvent.findUnique({
      where: {
        ingestCredentialId_clientEventId: {
          ingestCredentialId: credentialId,
          clientEventId,
        },
      },
      include: EVENT_INCLUDE,
    });
    return row ? mapEvent(row) : null;
  }

  async findEvent(householdId: string, id: string) {
    const row = await this.prisma.bankNotificationEvent.findFirst({
      where: { id, householdId },
      include: EVENT_INCLUDE,
    });
    return row ? mapEvent(row) : null;
  }

  async findLatestBalanceObservations(
    householdId: string,
  ): Promise<BalanceObservation[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        asset_id: string;
        current_value: Prisma.Decimal | null;
        bank_event_id: string;
        reported_balance_minor: bigint;
        superseded: boolean;
      }>
    >`
      SELECT DISTINCT ON (l.asset_id)
        l.asset_id, a.current_value,
        e.id AS bank_event_id, e.reported_balance_minor,
        EXISTS (
          SELECT 1 FROM money_events r
           WHERE l.asset_id IN (r.to_asset_id, r.from_asset_id)
             AND r.event_type NOT IN ('asset_update', 'asset_quantity_adjustment')
             AND r.deleted_at IS NULL
             AND (r.created_at, r.id) > (m.created_at, m.id)
        ) AS superseded
      FROM bank_source_links l
      JOIN assets a ON a.id = l.asset_id AND a.deleted_at IS NULL
      JOIN bank_notification_events e
        ON e.source_id = l.external_source_id
       AND e.matched_asset_id = l.asset_id
       AND e.status = 'PROCESSED'
       AND e.reported_balance_minor IS NOT NULL
      JOIN money_events m
        ON m.notification_event_id IN (e.id, e.transfer_peer_event_id)
       AND m.deleted_at IS NULL
      WHERE l.household_id = ${householdId}::uuid AND l.valid_to IS NULL
      ORDER BY l.asset_id, COALESCE(e.transaction_at, e.notification_at, e.received_at) DESC, e.received_at DESC
    `;
    return rows.map((row) => ({
      assetId: row.asset_id,
      bankEventId: row.bank_event_id,
      reportedBalance: Number(row.reported_balance_minor),
      currentValue: Number(row.current_value ?? 0),
      superseded: row.superseded,
    }));
  }

  async lockEvent(id: string): Promise<BankNotificationEvent | null> {
    await this.prisma
      .$queryRaw`SELECT id FROM bank_notification_events WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await this.prisma.bankNotificationEvent.findUnique({
      where: { id },
      include: EVENT_INCLUDE,
    });
    return row ? mapEvent(row) : null;
  }

  async updateEvent(id: string, patch: BankEventPatch): Promise<void> {
    const { rawPayloadCiphertext, ...rest } = patch;
    const data: Prisma.BankNotificationEventUncheckedUpdateInput = { ...rest };
    if (rawPayloadCiphertext !== undefined) {
      data.rawPayloadCiphertext = toBytes(rawPayloadCiphertext);
    }
    await this.prisma.bankNotificationEvent.update({ where: { id }, data });
  }

  async listEvents(
    householdId: string,
    statuses: BankEventStatus[],
    cursor: Date | null,
    limit: number,
  ) {
    const rows = await this.prisma.bankNotificationEvent.findMany({
      where: {
        householdId,
        status: { in: statuses },
        ...NOT_HELD,
        ...(cursor ? { receivedAt: { lt: cursor } } : {}),
      },
      orderBy: { receivedAt: 'desc' },
      take: limit,
      include: EVENT_INCLUDE,
    });
    return rows.map(mapEvent);
  }

  async countOpenByStatus(householdId: string) {
    const rows = await this.prisma.bankNotificationEvent.groupBy({
      by: ['status'],
      where: { householdId, status: { in: OPEN_STATUSES }, ...NOT_HELD },
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
  }

  async existsSamePayload(
    householdId: string,
    fingerprint: string,
    since: Date,
    excludeId: string,
  ) {
    const row = await this.prisma.bankNotificationEvent.findFirst({
      where: {
        householdId,
        payloadFingerprint: fingerprint,
        receivedAt: { gte: since },
        id: { not: excludeId },
      },
      select: { id: true },
    });
    return row !== null;
  }

  async findUnmappedByIdentifier(
    householdId: string,
    providerCode: string,
    identifierHmac: string,
  ) {
    const rows = await this.prisma.bankNotificationEvent.findMany({
      where: { householdId, providerCode, identifierHmac, status: 'UNMAPPED' },
      orderBy: { receivedAt: 'asc' },
      include: EVENT_INCLUDE,
    });
    return rows.map(mapEvent);
  }

  async findTransferPeer(params: {
    householdId: string;
    eventId: string;
    direction: string;
    amountMinor: number;
    sourceId: string;
    counterpartSourceId: string | null;
    from: Date;
    to: Date;
  }) {
    const window = { gte: params.from, lte: params.to };
    const pointsAtUs: Prisma.BankNotificationEventWhereInput[] = [
      { counterpartSourceId: params.sourceId },
    ];
    if (params.counterpartSourceId) {
      pointsAtUs.push({ sourceId: params.counterpartSourceId });
    }
    const row = await this.prisma.bankNotificationEvent.findFirst({
      where: {
        householdId: params.householdId,
        id: { not: params.eventId },
        direction: params.direction === 'IN' ? 'OUT' : 'IN',
        amountMinor: BigInt(params.amountMinor),
        transferPeerEventId: null,
        sourceId: { not: params.sourceId },
        matchedAssetId: { not: null },
        status: { notIn: ['DUPLICATE', 'IGNORED', 'PARSE_FAILED'] },
        AND: [
          { OR: pointsAtUs },
          {
            OR: [
              { transactionAt: window },
              { transactionAt: null, notificationAt: window },
              { transactionAt: null, notificationAt: null, receivedAt: window },
            ],
          },
          // A settled money event belongs to its cashflow, not to a transfer.
          {
            OR: [
              { moneyEvent: { is: null } },
              {
                moneyEvent: { is: { cashflowEventId: null, deletedAt: null } },
              },
            ],
          },
        ],
      },
      orderBy: { receivedAt: 'asc' },
      include: EVENT_INCLUDE,
    });
    return row ? mapEvent(row) : null;
  }

  async findLateTransferPeer(params: {
    householdId: string;
    eventId: string;
    direction: string;
    amountMinor: number;
    sourceId: string;
    counterpartSourceId: string | null;
    walletId: string;
    from: Date;
    to: Date;
  }) {
    const window = { gte: params.from, lte: params.to };
    const pointsAtUs: Prisma.BankNotificationEventWhereInput[] = [
      { counterpartSourceId: params.sourceId },
    ];
    if (params.counterpartSourceId) {
      pointsAtUs.push({ sourceId: params.counterpartSourceId });
    }
    const ownSide =
      params.direction === 'IN'
        ? { toAssetId: params.walletId }
        : { fromAssetId: params.walletId };
    const row = await this.prisma.bankNotificationEvent.findFirst({
      where: {
        householdId: params.householdId,
        id: { not: params.eventId },
        direction: params.direction === 'IN' ? 'OUT' : 'IN',
        amountMinor: BigInt(params.amountMinor),
        transferPeerEventId: null,
        sourceId: { not: params.sourceId },
        matchedAssetId: { not: null },
        AND: [
          { OR: pointsAtUs },
          {
            OR: [
              { transactionAt: window },
              { transactionAt: null, notificationAt: window },
              { transactionAt: null, notificationAt: null, receivedAt: window },
            ],
          },
          {
            OR: [
              {
                status: 'PROCESSED',
                moneyEvent: {
                  is: {
                    eventType: 'transfer',
                    cashflowEventId: null,
                    deletedAt: null,
                    ...ownSide,
                  },
                },
              },
              {
                status: 'REVIEW',
                statusReason: TRANSFER_AWAITING_PEER,
                moneyEvent: { is: null },
              },
            ],
          },
        ],
      },
      orderBy: { receivedAt: 'asc' },
      include: EVENT_INCLUDE,
    });
    return row ? mapEvent(row) : null;
  }

  pairTransfer(aId: string, bId: string): Promise<boolean> {
    return this.runInTransaction(async (tx) => {
      for (const [id, peer] of [
        [aId, bId],
        [bId, aId],
      ]) {
        const { count } = await tx.bankNotificationEvent.updateMany({
          where: { id, transferPeerEventId: null },
          data: { transferPeerEventId: peer },
        });
        // Throwing rolls back the first leg.
        if (count === 0) throw new TransferAlreadyPaired();
      }
      return true;
    }).catch((error: unknown) => {
      if (error instanceof TransferAlreadyPaired || isUniqueViolation(error)) {
        return false;
      }
      throw error;
    });
  }

  async hasOtherLinkedSource(householdId: string, sourceId: string) {
    const count = await this.prisma.bankExternalSource.count({
      where: {
        householdId,
        id: { not: sourceId },
        status: 'ACTIVE',
        links: { some: { validTo: null } },
      },
    });
    return count > 0;
  }

  findHeldEvents(before: Date, limit: number) {
    return this.prisma.bankNotificationEvent.findMany({
      where: {
        status: 'REVIEW',
        statusReason: TRANSFER_AWAITING_PEER,
        receivedAt: { lt: before },
      },
      orderBy: { receivedAt: 'asc' },
      take: limit,
      select: { id: true, householdId: true },
    });
  }

  async claimHeldEvent(id: string) {
    const { count } = await this.prisma.bankNotificationEvent.updateMany({
      where: { id, status: 'REVIEW', statusReason: TRANSFER_AWAITING_PEER },
      data: { status: 'RECEIVED', statusReason: null },
    });
    return count === 1;
  }

  async purgeExpiredRaw(now: Date, limit: number): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE bank_notification_events
         SET raw_payload_ciphertext = NULL
       WHERE id IN (
         SELECT id FROM bank_notification_events
          WHERE raw_payload_ciphertext IS NOT NULL AND raw_expires_at <= ${now}
          LIMIT ${limit}
       )`;
  }
}

class TransferAlreadyPaired extends Error {}

function toBytes(
  value: Buffer | null | undefined,
): Uint8Array<ArrayBuffer> | null {
  if (!value) return null;
  const copy = new Uint8Array(new ArrayBuffer(value.length));
  copy.set(value);
  return copy;
}

function mapLink(row: BankSourceLinkRow): BankSourceLink {
  return {
    id: row.id,
    householdId: row.householdId,
    externalSourceId: row.externalSourceId,
    assetId: row.assetId,
    postingMode: row.postingMode,
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}

type EventRow = Prisma.BankNotificationEventGetPayload<{
  include: typeof EVENT_INCLUDE;
}>;

function mapEvent(row: EventRow): BankNotificationEvent {
  return {
    id: row.id,
    householdId: row.householdId,
    userId: row.userId,
    ingestCredentialId: row.ingestCredentialId,
    clientEventId: row.clientEventId,
    providerCode: row.providerCode as ProviderCode | null,
    appName: row.appName,
    titleRedacted: row.titleRedacted,
    rawPayloadCiphertext: row.rawPayloadCiphertext
      ? Buffer.from(row.rawPayloadCiphertext)
      : null,
    rawExpiresAt: row.rawExpiresAt,
    payloadFingerprint: row.payloadFingerprint,
    identifierHmac: row.identifierHmac,
    identifierLast4: row.identifierLast4,
    sourceId: row.sourceId,
    matchedAssetId: row.matchedAssetId,
    amountMinor: row.amountMinor != null ? Number(row.amountMinor) : null,
    direction: row.direction as BankDirection | null,
    reportedBalanceMinor:
      row.reportedBalanceMinor != null
        ? Number(row.reportedBalanceMinor)
        : null,
    transactionAt: row.transactionAt,
    notificationAt: row.notificationAt,
    timeSource: row.timeSource,
    externalReference: row.externalReference,
    description: row.description,
    parserVersion: row.parserVersion,
    status: row.status,
    statusReason: row.statusReason,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
    processedById: row.processedById,
    suggestedCashflowEventId: row.suggestedCashflowEventId,
    matchStatus: row.matchStatus,
    matchReason: row.matchReason,
    counterpartSourceId: row.counterpartSourceId,
    transferPeerEventId: row.transferPeerEventId,
    moneyEventId: row.moneyEvent?.id ?? null,
    moneyEventType: row.moneyEvent?.eventType ?? null,
  };
}
