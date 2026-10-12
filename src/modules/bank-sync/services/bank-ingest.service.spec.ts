import { randomBytes } from 'node:crypto';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';
import type { BankNotificationEvent } from '../entities/bank-sync.entity';
import { BankIngestService } from './bank-ingest.service';
import type { BankPostingService } from './bank-posting.service';

const CTX = { credentialId: 'cred-1', userId: 'user-1', householdId: 'hh-1' };
const VCB = (sign = '+', amount = '2,000') => ({
  clientEventId: '550e8400-e29b-41d4-a716-446655440000',
  app: 'VCB Digibank',
  title: 'Thông báo VCB',
  body: `Số dư TK VCB 0123456789 ${sign}${amount} VND lúc 12-10-2026 14:44:34. Số dư 24,056,118 VND.`,
  notificationAt: null,
});
const SOURCE = {
  id: 'src-1',
  householdId: 'hh-1',
  createdById: 'user-1',
  sourceType: 'BANK_ACCOUNT' as const,
  providerCode: 'VCB',
  identifierHmac: 'h',
  identifierLast4: '6789',
  displayLabel: null,
  status: 'ACTIVE' as const,
  createdAt: new Date(),
};
const LINK = (postingMode: 'AUTO' | 'REVIEW') => ({
  id: 'link-1',
  householdId: 'hh-1',
  externalSourceId: 'src-1',
  assetId: 'wallet-1',
  postingMode,
  validFrom: new Date('2026-01-01'),
  validTo: null,
});
const WALLET = {
  id: 'wallet-1',
  name: 'VCB',
  type: 'bank_account',
  status: 'active',
  deletedAt: null,
};

function setup() {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const repo = {
    createId: jest.fn(() => 'evt-1'),
    insertEvent: jest.fn().mockResolvedValue(true),
    findEventByClientId: jest.fn(),
    existsSamePayload: jest.fn().mockResolvedValue(false),
    updateEvent: jest.fn((id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      return Promise.resolve();
    }),
    findSourceByIdentity: jest.fn().mockResolvedValue(SOURCE),
    findLinksAt: jest.fn().mockResolvedValue([LINK('AUTO')]),
    hasLinkClosedBetween: jest.fn().mockResolvedValue(false),
    findWallet: jest.fn().mockResolvedValue(WALLET),
    existsSimilar: jest.fn().mockResolvedValue(false),
    findUnmappedByIdentifier: jest.fn().mockResolvedValue([]),
  };
  const posting = { post: jest.fn().mockResolvedValue('posted') };
  const service = new BankIngestService(
    repo as unknown as BankSyncRepository,
    posting as unknown as BankPostingService,
  );
  const lastStatus = () => updates[updates.length - 1]?.patch;
  return { repo, posting, service, updates, lastStatus };
}

beforeAll(() => {
  process.env.BANK_SYNC_HMAC_KEY = randomBytes(32).toString('base64');
  process.env.BANK_SYNC_PAYLOAD_KEY = randomBytes(32).toString('base64');
  // Prisma loads the developer's .env on import; pin the flag.
  process.env.BANK_SYNC_STORE_RAW_PAYLOAD = 'true';
});

describe('BankIngestService.ingest', () => {
  it('auto-posts a valid event on an AUTO link', async () => {
    const { service, posting } = setup();
    const out = await service.ingest(CTX, VCB());
    expect(out.status).toBe('PROCESSED');
    expect(posting.post).toHaveBeenCalledWith('hh-1', 'evt-1', 'user-1');
  });

  it('stores the raw payload encrypted, never in plaintext', async () => {
    const { service, repo } = setup();
    await service.ingest(CTX, VCB());
    const [[row]] = repo.insertEvent.mock.calls as unknown as [
      [BankNotificationEvent],
    ];
    expect(row.rawPayloadCiphertext?.toString('utf8')).not.toContain(
      '0123456789',
    );
    expect(JSON.stringify(row)).not.toContain('0123456789');
  });

  it('stores no raw payload when the flag is off, but still fingerprints', async () => {
    process.env.BANK_SYNC_STORE_RAW_PAYLOAD = 'false';
    try {
      const { service, repo } = setup();
      await service.ingest(CTX, VCB());
      const [[row]] = repo.insertEvent.mock.calls as unknown as [
        [BankNotificationEvent],
      ];
      expect(row.rawPayloadCiphertext).toBeNull();
      expect(row.rawExpiresAt).toBeNull();
      expect(row.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      process.env.BANK_SYNC_STORE_RAW_PAYLOAD = 'true';
    }
  });

  it('derives the same clientEventId for the same notification', async () => {
    const { service, repo } = setup();
    const noId = { ...VCB(), clientEventId: null };
    await service.ingest(CTX, noId);
    await service.ingest(CTX, noId);
    const ids = (
      repo.insertEvent.mock.calls as unknown as [BankNotificationEvent][]
    ).map(([row]) => row.clientEventId);
    expect(ids[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(ids[1]).toBe(ids[0]);
  });

  it('answers a retried clientEventId without reprocessing', async () => {
    const { service, repo, posting } = setup();
    repo.insertEvent.mockResolvedValue(false);
    repo.findEventByClientId.mockResolvedValue({
      id: 'evt-0',
      status: 'PROCESSED',
    });
    const out = await service.ingest(CTX, VCB());
    expect(out).toEqual({
      eventId: 'evt-0',
      status: 'PROCESSED',
      replayed: true,
    });
    expect(posting.post).not.toHaveBeenCalled();
  });

  it('marks an identical payload under a new UUID as DUPLICATE', async () => {
    const { service, repo, posting } = setup();
    repo.existsSamePayload.mockResolvedValue(true);
    const out = await service.ingest(CTX, VCB());
    expect(out.status).toBe('DUPLICATE');
    expect(posting.post).not.toHaveBeenCalled();
  });

  it('refuses an app outside the allowlist', async () => {
    const { service, lastStatus } = setup();
    const out = await service.ingest(CTX, { ...VCB(), app: 'Zalo' });
    expect(out.status).toBe('PARSE_FAILED');
    expect(lastStatus()).toMatchObject({ statusReason: 'APP_NOT_SUPPORTED' });
  });

  it('parks an unknown account as UNMAPPED', async () => {
    const { service, repo, posting } = setup();
    repo.findSourceByIdentity.mockResolvedValue(null);
    expect((await service.ingest(CTX, VCB())).status).toBe('UNMAPPED');
    expect(posting.post).not.toHaveBeenCalled();
  });

  it('keeps a REVIEW link in the inbox', async () => {
    const { service, repo, posting, lastStatus } = setup();
    repo.findLinksAt.mockResolvedValue([LINK('REVIEW')]);
    expect((await service.ingest(CTX, VCB())).status).toBe('REVIEW');
    expect(lastStatus()).toMatchObject({
      statusReason: 'MANUAL_MODE',
      matchedAssetId: 'wallet-1',
    });
    expect(posting.post).not.toHaveBeenCalled();
  });

  it('does not post into a closed wallet', async () => {
    const { service, repo, posting, lastStatus } = setup();
    repo.findWallet.mockResolvedValue({ ...WALLET, status: 'closed' });
    expect((await service.ingest(CTX, VCB())).status).toBe('REVIEW');
    expect(lastStatus()).toMatchObject({ statusReason: 'ASSET_UNAVAILABLE' });
    expect(posting.post).not.toHaveBeenCalled();
  });

  it('holds a same-amount event on the same source for review', async () => {
    const { service, repo, lastStatus } = setup();
    repo.existsSimilar.mockResolvedValue(true);
    expect((await service.ingest(CTX, VCB())).status).toBe('REVIEW');
    expect(lastStatus()).toMatchObject({ statusReason: 'POSSIBLE_DUPLICATE' });
    expect(repo.existsSimilar).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'src-1', amountMinor: 2000 }),
    );
  });

  it('holds OUT for review while no real sample is verified', async () => {
    const { service, posting, lastStatus } = setup();
    expect((await service.ingest(CTX, VCB('-', '150,000'))).status).toBe(
      'REVIEW',
    );
    expect(lastStatus()).toMatchObject({ statusReason: 'OUT_UNVERIFIED' });
    expect(posting.post).not.toHaveBeenCalled();
  });

  it('reviews when the link was changed around the transaction time', async () => {
    const { service, repo, lastStatus } = setup();
    repo.hasLinkClosedBetween.mockResolvedValue(true);
    expect((await service.ingest(CTX, VCB())).status).toBe('REVIEW');
    expect(lastStatus()).toMatchObject({ statusReason: 'LINK_CHANGED' });
  });

  it('records FAILED when posting throws', async () => {
    const { service, posting, lastStatus } = setup();
    posting.post.mockRejectedValue(new Error('db down'));
    expect((await service.ingest(CTX, VCB())).status).toBe('FAILED');
    expect(lastStatus()).toMatchObject({ statusReason: 'POST_FAILED' });
  });
});

describe('BankIngestService.reprocessUnmapped', () => {
  it('lifts old events to REVIEW at most, even on an AUTO link', async () => {
    const { service, repo, posting, lastStatus } = setup();
    repo.findUnmappedByIdentifier.mockResolvedValue([
      {
        id: 'evt-old',
        householdId: 'hh-1',
        providerCode: 'VCB',
        identifierHmac: 'h',
        amountMinor: 2000,
        direction: 'IN',
        transactionAt: new Date(),
        notificationAt: null,
        receivedAt: new Date(),
        status: 'UNMAPPED',
      },
    ]);
    await service.reprocessUnmapped('hh-1', 'VCB', 'h', 'user-1');
    expect(posting.post).not.toHaveBeenCalled();
    expect(lastStatus()).toMatchObject({
      status: 'REVIEW',
      statusReason: 'MANUAL_MODE',
    });
  });
});
