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

import type { BalanceObservation } from '../domain/wallet-drift';

export const BANK_SYNC_REPOSITORY = Symbol('BANK_SYNC_REPOSITORY');

export interface SourceWithLink extends BankExternalSource {
  openLink: (BankSourceLink & { assetName: string }) | null;
}

export interface BankSyncRepository {
  createId(): string;

  // Credentials
  insertCredential(row: BankCredential & { tokenHash: string }): Promise<void>;
  listCredentials(
    householdId: string,
    userId: string,
  ): Promise<BankCredential[]>;
  revokeCredential(
    householdId: string,
    userId: string,
    id: string,
    at: Date,
  ): Promise<boolean>;
  findCredentialByHash(tokenHash: string): Promise<BankCredential | null>;
  touchCredential(id: string, at: Date): Promise<void>;
  isLiveMember(householdId: string, userId: string): Promise<boolean>;

  // Sources and links
  insertSource(row: BankExternalSource): Promise<void>;
  findSource(
    householdId: string,
    id: string,
  ): Promise<BankExternalSource | null>;
  findSourceByIdentity(
    householdId: string,
    providerCode: string,
    identifierHmac: string,
  ): Promise<BankExternalSource | null>;
  listSources(householdId: string): Promise<SourceWithLink[]>;
  updateSource(
    householdId: string,
    id: string,
    patch: { displayLabel?: string | null; status?: BankSourceStatus },
  ): Promise<void>;
  findOpenLink(sourceId: string): Promise<BankSourceLink | null>;
  findLinksAt(sourceId: string, at: Date): Promise<BankSourceLink[]>;
  hasLinkClosedBetween(
    sourceId: string,
    from: Date,
    to: Date,
  ): Promise<boolean>;
  closeOpenLink(sourceId: string, at: Date): Promise<void>;
  insertLink(row: BankSourceLink & { createdById: string }): Promise<void>;
  updateLinkMode(linkId: string, mode: BankPostingMode): Promise<void>;
  findWallet(householdId: string, assetId: string): Promise<WalletRef | null>;
  findSourcesByHmacs(
    householdId: string,
    hmacs: string[],
  ): Promise<BankExternalSource[]>;

  // Events
  insertEvent(row: BankNotificationEvent): Promise<boolean>;
  findEventByClientId(
    credentialId: string,
    clientEventId: string,
  ): Promise<BankNotificationEvent | null>;
  findEvent(
    householdId: string,
    id: string,
  ): Promise<BankNotificationEvent | null>;
  /** `SELECT … FOR UPDATE`; call inside a transaction. */
  lockEvent(id: string): Promise<BankNotificationEvent | null>;
  updateEvent(id: string, patch: BankEventPatch): Promise<void>;
  listEvents(
    householdId: string,
    statuses: BankEventStatus[],
    cursor: Date | null,
    limit: number,
  ): Promise<BankNotificationEvent[]>;
  countOpenByStatus(
    householdId: string,
  ): Promise<Partial<Record<BankEventStatus, number>>>;
  existsSamePayload(
    householdId: string,
    fingerprint: string,
    since: Date,
    excludeId: string,
  ): Promise<boolean>;
  /** Newest processed balance report per open-linked wallet. */
  findLatestBalanceObservations(
    householdId: string,
  ): Promise<BalanceObservation[]>;
  findUnmappedByIdentifier(
    householdId: string,
    providerCode: string,
    identifierHmac: string,
  ): Promise<BankNotificationEvent[]>;
  /** The other leg of an own-account transfer. See memory/bank-sync.md. */
  findTransferPeer(params: {
    householdId: string;
    eventId: string;
    direction: string;
    amountMinor: number;
    sourceId: string;
    counterpartSourceId: string | null;
    from: Date;
    to: Date;
  }): Promise<BankNotificationEvent | null>;
  /** Wider window, but only a leg already tied to `walletId`. See memory/bank-sync.md (Ghép muộn). */
  findLateTransferPeer(params: {
    householdId: string;
    eventId: string;
    direction: string;
    amountMinor: number;
    sourceId: string;
    counterpartSourceId: string | null;
    walletId: string;
    from: Date;
    to: Date;
  }): Promise<BankNotificationEvent | null>;
  /** False when either event is already paired. */
  pairTransfer(aId: string, bId: string): Promise<boolean>;
  purgeExpiredRaw(now: Date, limit: number): Promise<number>;
}
