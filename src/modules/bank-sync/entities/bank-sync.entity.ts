import type {
  BankCredentialStatus,
  BankEventStatus,
  BankPostingMode,
  BankSourceStatus,
  BankSourceType,
  BankTimeSource,
} from '@prisma/client';
import type {
  BankDirection,
  ProviderCode,
} from '../parsers/bank-notification-parser';

export type {
  BankCredentialStatus,
  BankEventStatus,
  BankPostingMode,
  BankSourceStatus,
  BankSourceType,
  BankTimeSource,
};

/** Resolved from the device token by the ingest guard. */
export interface BankIngestContext {
  credentialId: string;
  userId: string;
  householdId: string;
}

export interface BankCredential {
  id: string;
  userId: string;
  householdId: string;
  deviceLabel: string;
  tokenPrefix: string | null;
  status: BankCredentialStatus;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface BankExternalSource {
  id: string;
  householdId: string;
  createdById: string;
  sourceType: BankSourceType;
  providerCode: string;
  identifierHmac: string;
  identifierLast4: string | null;
  displayLabel: string | null;
  status: BankSourceStatus;
  createdAt: Date;
}

export interface BankSourceLink {
  id: string;
  householdId: string;
  externalSourceId: string;
  assetId: string;
  postingMode: BankPostingMode;
  validFrom: Date;
  validTo: Date | null;
}

export interface WalletRef {
  id: string;
  name: string;
  type: string;
  status: string;
  deletedAt: Date | null;
}

export interface BankNotificationEvent {
  id: string;
  householdId: string;
  userId: string;
  ingestCredentialId: string;
  clientEventId: string;
  providerCode: ProviderCode | null;
  appName: string;
  titleRedacted: string | null;
  rawPayloadCiphertext: Buffer | null;
  rawExpiresAt: Date | null;
  payloadFingerprint: string | null;
  identifierHmac: string | null;
  identifierLast4: string | null;
  sourceId: string | null;
  matchedAssetId: string | null;
  amountMinor: number | null;
  direction: BankDirection | null;
  reportedBalanceMinor: number | null;
  transactionAt: Date | null;
  notificationAt: Date | null;
  timeSource: BankTimeSource | null;
  externalReference: string | null;
  description: string | null;
  parserVersion: string | null;
  status: BankEventStatus;
  statusReason: string | null;
  receivedAt: Date;
  processedAt: Date | null;
  processedById: string | null;
  /** Note-rule suggestion. See memory/cashflow-settlement.md. */
  suggestedCashflowEventId: string | null;
  matchStatus: string | null;
  matchReason: string | null;
  moneyEventId: string | null;
}

export type BankEventPatch = Partial<
  Omit<
    BankNotificationEvent,
    | 'id'
    | 'householdId'
    | 'userId'
    | 'ingestCredentialId'
    | 'clientEventId'
    | 'moneyEventId'
  >
>;
