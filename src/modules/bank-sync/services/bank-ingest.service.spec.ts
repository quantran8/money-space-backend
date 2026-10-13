import { ConflictException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';
import type { BankNotificationEvent } from '../entities/bank-sync.entity';
import { bankSyncConfig } from '../../../config/bank-sync.config';
import { identifierHmac } from '../domain/identifier-hmac';
import { BankIngestService, noteFromBody } from './bank-ingest.service';
import type { BankPostingService } from './bank-posting.service';
import type { CashflowMatcherService } from '../../cashflow-events/services/cashflow-matcher.service';

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
    findUnmappedByIdentifier: jest.fn().mockResolvedValue([]),
    findEvent: jest.fn().mockResolvedValue(null),
    findSourcesByHmacs: jest.fn().mockResolvedValue([]),
    findTransferPeer: jest.fn().mockResolvedValue(null),
    findLateTransferPeer: jest.fn().mockResolvedValue(null),
    pairTransfer: jest.fn().mockResolvedValue(true),
    hasOtherLinkedSource: jest.fn().mockResolvedValue(false),
    claimHeldEvent: jest.fn().mockResolvedValue(true),
    claimStaleReceived: jest.fn().mockResolvedValue(true),
  };
  const posting = { post: jest.fn().mockResolvedValue('posted') };
  const matcher = {
    match: jest.fn().mockResolvedValue({ status: 'none', reason: 'NO_RULE' }),
  };
  const service = new BankIngestService(
    repo as unknown as BankSyncRepository,
    posting as unknown as BankPostingService,
    matcher as unknown as CashflowMatcherService,
  );
  const lastStatus = () => updates[updates.length - 1]?.patch;
  return { repo, posting, matcher, service, updates, lastStatus };
}

beforeAll(() => {
  process.env.BANK_SYNC_HMAC_KEY = randomBytes(32).toString('base64');
  process.env.BANK_SYNC_PAYLOAD_KEY = randomBytes(32).toString('base64');
  // Prisma loads the developer's .env on import; pin the flag.
  process.env.BANK_SYNC_STORE_RAW_PAYLOAD = 'true';
});

describe('BankIngestService.ingest', () => {
  it('stores the masked body as the event description', async () => {
    const { service, updates } = setup();
    await service.ingest(CTX, VCB());
    const parsed = updates.find((u) => 'description' in u.patch)?.patch;
    expect(parsed?.description).toContain('Số dư TK VCB ••6789 +2,000 VND');
    expect(parsed?.description).not.toContain('0123456789');
  });

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

  it('auto-posts an OUT when the household has no other bank account', async () => {
    const { service, posting } = setup();
    const out = await service.ingest(CTX, VCB('-', '150,000'));
    expect(out.status).toBe('PROCESSED');
    expect(posting.post).toHaveBeenCalled();
  });

  describe('OUT hold for a transfer leg', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('holds an OUT while another account could send its IN leg', async () => {
      const { service, repo, posting, lastStatus } = setup();
      repo.hasOtherLinkedSource.mockResolvedValue(true);
      const out = await service.ingest(CTX, VCB('-', '150,000'));
      expect(out.status).toBe('REVIEW');
      expect(lastStatus()).toMatchObject({
        statusReason: 'TRANSFER_AWAITING_PEER',
      });
      expect(posting.post).not.toHaveBeenCalled();
    });

    it('routes the held OUT as an ordinary event after the hold', async () => {
      const { service, repo, posting } = setup();
      repo.hasOtherLinkedSource.mockResolvedValue(true);
      await service.ingest(CTX, VCB('-', '150,000'));
      repo.findEvent.mockResolvedValue({
        id: 'evt-1',
        householdId: 'hh-1',
        userId: 'user-1',
        providerCode: 'VCB',
        identifierHmac: 'h',
        amountMinor: 150000,
        direction: 'OUT',
        transactionAt: new Date(),
        notificationAt: null,
        receivedAt: new Date(),
        status: 'RECEIVED',
        transferPeerEventId: null,
      });
      await jest.advanceTimersByTimeAsync(10_000);
      expect(repo.claimHeldEvent).toHaveBeenCalledWith('evt-1');
      expect(posting.post).toHaveBeenCalledWith('hh-1', 'evt-1', 'user-1');
    });

    it('leaves a held OUT alone once its IN leg claimed it', async () => {
      const { service, repo, posting } = setup();
      repo.claimHeldEvent.mockResolvedValue(false);
      await service.releaseHeld('hh-1', 'evt-1');
      expect(repo.findEvent).not.toHaveBeenCalled();
      expect(posting.post).not.toHaveBeenCalled();
    });
  });

  describe('recoverStale', () => {
    const STALE = {
      id: 'evt-1',
      householdId: 'hh-1',
      userId: 'user-1',
      providerCode: 'VCB',
      identifierHmac: 'h',
      amountMinor: 150000,
      direction: 'IN',
      transactionAt: new Date(),
      notificationAt: null,
      receivedAt: new Date(),
      status: 'FAILED',
      statusReason: 'INTERRUPTED',
      transferPeerEventId: null,
      moneyEventId: null,
      parserVersion: 'vcb@1',
      rawPayloadCiphertext: null,
    };

    it('routes a parsed event to the inbox, never auto-posting', async () => {
      const { service, repo, posting, lastStatus } = setup();
      repo.findEvent.mockResolvedValue(STALE);
      await service.recoverStale('hh-1', 'evt-1');
      expect(repo.claimStaleReceived).toHaveBeenCalledWith('evt-1');
      expect(posting.post).not.toHaveBeenCalled();
      expect(lastStatus()).toMatchObject({
        status: 'REVIEW',
        statusReason: 'MANUAL_MODE',
      });
    });

    it('leaves an unparsed event without raw payload as INTERRUPTED', async () => {
      const { service, repo, updates } = setup();
      repo.findEvent.mockResolvedValue({ ...STALE, parserVersion: null });
      await service.recoverStale('hh-1', 'evt-1');
      expect(updates).toHaveLength(0);
    });

    it('does nothing when another sweep claimed it', async () => {
      const { service, repo } = setup();
      repo.claimStaleReceived.mockResolvedValue(false);
      await service.recoverStale('hh-1', 'evt-1');
      expect(repo.findEvent).not.toHaveBeenCalled();
    });
  });

  it('reviews when the link was changed around the transaction time', async () => {
    const { service, repo, lastStatus } = setup();
    repo.hasLinkClosedBetween.mockResolvedValue(true);
    expect((await service.ingest(CTX, VCB())).status).toBe('REVIEW');
    expect(lastStatus()).toMatchObject({ statusReason: 'LINK_CHANGED' });
  });

  it('auto-settles the occurrence a unique note rule matched', async () => {
    const { service, posting, matcher } = setup();
    matcher.match.mockResolvedValue({
      status: 'matched',
      reason: 'NOTE_RULE',
      cashflowEventId: 'cf-1',
      ruleId: 'r-1',
    });
    expect((await service.ingest(CTX, VCB())).status).toBe('PROCESSED');
    expect(posting.post).toHaveBeenCalledWith(
      'hh-1',
      'evt-1',
      'user-1',
      undefined,
      {
        kind: 'link',
        cashflowEventId: 'cf-1',
        via: 'auto_note',
        matchRuleId: 'r-1',
      },
    );
  });

  it('still posts the money when settling conflicts', async () => {
    const { service, posting, matcher, updates } = setup();
    matcher.match.mockResolvedValue({
      status: 'matched',
      reason: 'NOTE_RULE',
      cashflowEventId: 'cf-1',
      ruleId: 'r-1',
    });
    posting.post
      .mockRejectedValueOnce(new ConflictException('settled'))
      .mockResolvedValueOnce('posted');
    expect((await service.ingest(CTX, VCB())).status).toBe('PROCESSED');
    expect(posting.post).toHaveBeenLastCalledWith('hh-1', 'evt-1', 'user-1');
    expect(updates.some((u) => u.patch.matchReason === 'SETTLE_CONFLICT')).toBe(
      true,
    );
  });

  it('holds a bank event that would duplicate a manual completion', async () => {
    const { service, posting, matcher, lastStatus } = setup();
    matcher.match.mockResolvedValue({
      status: 'replace_manual',
      reason: 'MANUAL_ALREADY_COMPLETED',
      cashflowEventId: 'cf-1',
    });
    expect((await service.ingest(CTX, VCB())).status).toBe('REVIEW');
    expect(posting.post).not.toHaveBeenCalled();
    expect(lastStatus()).toMatchObject({
      statusReason: 'MATCH_REPLACE_MANUAL',
      suggestedCashflowEventId: 'cf-1',
      matchStatus: 'replace_manual',
    });
  });

  it('posts without settling when the note is ambiguous', async () => {
    const { service, posting, matcher } = setup();
    matcher.match.mockResolvedValue({
      status: 'ambiguous',
      reason: 'MULTIPLE_EVENTS',
    });
    await service.ingest(CTX, VCB());
    expect(posting.post).toHaveBeenCalledWith('hh-1', 'evt-1', 'user-1');
  });

  it('drops a promo notification without storing anything', async () => {
    const { service, repo } = setup();
    const out = await service.ingest(CTX, {
      clientEventId: null,
      app: 'Techcombank',
      title: 'Tài khoản thưởng đã được kích hoạt lại',
      body: 'Tiếp tục khám phá các ưu đãi hấp dẫn Techcombank dành tặng bạn nhé',
      notificationAt: null,
    });
    expect(out).toEqual({
      eventId: null,
      status: 'NOT_TRANSACTION',
      replayed: false,
    });
    expect(repo.insertEvent).not.toHaveBeenCalled();
  });

  it('records FAILED when posting throws', async () => {
    const { service, posting, lastStatus } = setup();
    posting.post.mockRejectedValue(new Error('db down'));
    expect((await service.ingest(CTX, VCB())).status).toBe('FAILED');
    expect(lastStatus()).toMatchObject({ statusReason: 'POST_FAILED' });
  });
});

describe('BankIngestService own-account transfer', () => {
  const TCB_ACCOUNT = '19031234567801';
  const VCB_FROM_TCB = {
    ...VCB(),
    body: `${VCB().body} Ref 6286IBT1k252X54K.NGUYEN VAN A chuyen FT26286132204071.20261012.144434.${TCB_ACCOUNT}.VND-TGTT-NGUYEN VAN A.970407`,
  };
  const TCB_OUT = {
    clientEventId: '550e8400-e29b-41d4-a716-446655440001',
    app: 'Techcombank',
    title: '- VND 2,000',
    body: 'Tài khoản: 1903 9999 0000 01\nSố dư: VND 1,000\nNGUYEN VAN A chuyen tien',
    notificationAt: new Date('2026-10-12T07:45:00Z'),
  };
  const TCB_SOURCE = { ...SOURCE, id: 'src-tcb', providerCode: 'TECHCOMBANK' };
  const PEER = {
    id: 'evt-peer',
    status: 'PROCESSED',
    statusReason: null,
    sourceId: 'src-tcb',
    transactionAt: null,
    notificationAt: new Date('2026-10-12T07:45:00Z'),
    receivedAt: new Date(),
  };

  function withTcb(
    tcbMode: 'AUTO' | 'REVIEW',
    vcbMode: 'AUTO' | 'REVIEW' = 'AUTO',
  ) {
    const t = setup();
    const tcbHmac = identifierHmac(
      bankSyncConfig.hmacKey as Buffer,
      'TECHCOMBANK',
      TCB_ACCOUNT,
    );
    t.repo.findSourcesByHmacs.mockImplementation(
      (_hh: string, hmacs: string[]) =>
        Promise.resolve(hmacs.includes(tcbHmac) ? [TCB_SOURCE] : []),
    );
    t.repo.findLinksAt.mockImplementation((sourceId: string) =>
      Promise.resolve([
        sourceId === 'src-tcb'
          ? {
              ...LINK(tcbMode),
              externalSourceId: 'src-tcb',
              assetId: 'wallet-tcb',
            }
          : LINK(vcbMode),
      ]),
    );
    return t;
  }

  it('posts an IN that names another household account as a transfer leg', async () => {
    const { service, posting, matcher, updates } = withTcb('AUTO');
    const out = await service.ingest(CTX, VCB_FROM_TCB);
    expect(out.status).toBe('PROCESSED');
    expect(posting.post).toHaveBeenCalledWith('hh-1', 'evt-1', 'user-1');
    expect(matcher.match).not.toHaveBeenCalled();
    expect(updates.at(-1)?.patch.counterpartSourceId).toBe('src-tcb');
  });

  it('keeps a transfer in review while the other account is on REVIEW', async () => {
    const { service, posting, lastStatus } = withTcb('REVIEW');
    await service.ingest(CTX, VCB_FROM_TCB);
    expect(lastStatus()).toMatchObject({
      status: 'REVIEW',
      statusReason: 'TRANSFER_REVIEW',
      counterpartSourceId: 'src-tcb',
    });
    expect(posting.post).not.toHaveBeenCalled();
  });

  it('pairs an OUT with the income its IN leg already posted', async () => {
    const { service, repo, posting } = setup();
    repo.findTransferPeer.mockResolvedValue({
      ...PEER,
      sourceId: 'src-vcb',
      moneyEventId: 'me-1',
      moneyEventType: 'income',
    });
    const out = await service.ingest(CTX, TCB_OUT);
    expect(repo.pairTransfer).toHaveBeenCalledWith('evt-1', 'evt-peer');
    expect(out.status).toBe('PROCESSED');
    expect(posting.post).toHaveBeenCalled();
  });

  it('closes the pair on a REVIEW link when the other leg already moved the money', async () => {
    const { service, repo, posting } = withTcb('AUTO', 'REVIEW');
    repo.findTransferPeer.mockResolvedValue({
      ...PEER,
      moneyEventId: 'me-0',
      moneyEventType: 'transfer',
    });
    const out = await service.ingest(CTX, VCB_FROM_TCB);
    expect(out.status).toBe('PROCESSED');
    expect(posting.post).toHaveBeenCalled();
  });

  it('closes a late OUT against the transfer its IN leg already posted', async () => {
    const { service, repo, posting } = setup();
    repo.findLateTransferPeer.mockResolvedValue({
      ...PEER,
      sourceId: 'src-vcb',
      moneyEventId: 'me-0',
      moneyEventType: 'transfer',
    });
    const out = await service.ingest(CTX, TCB_OUT);
    expect(repo.findLateTransferPeer).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'OUT', walletId: 'wallet-1' }),
    );
    expect(repo.pairTransfer).toHaveBeenCalledWith('evt-1', 'evt-peer');
    expect(out.status).toBe('PROCESSED');
    expect(posting.post).toHaveBeenCalled();
  });

  describe('legs routed at the same moment', () => {
    const ROUTED = {
      id: 'evt-1',
      householdId: 'hh-1',
      sourceId: 'src-tcb',
      matchedAssetId: 'wallet-tcb',
      counterpartSourceId: null,
      transferPeerEventId: null,
      amountMinor: 2000,
      transactionAt: null,
      notificationAt: null,
      receivedAt: new Date(),
    };

    it('closes a waiting OUT once the IN leg has posted the transfer', async () => {
      const { service, repo, posting } = setup();
      repo.findEvent.mockResolvedValue({
        ...ROUTED,
        direction: 'OUT',
        status: 'REVIEW',
        statusReason: 'TRANSFER_AWAITING_PEER',
        moneyEventType: null,
      });
      repo.findLateTransferPeer
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          ...PEER,
          sourceId: 'src-vcb',
          moneyEventId: 'me-0',
          moneyEventType: 'transfer',
        });
      const out = await service.ingest(CTX, TCB_OUT);
      expect(repo.pairTransfer).toHaveBeenCalledWith('evt-1', 'evt-peer');
      expect(posting.post).toHaveBeenCalledWith('hh-1', 'evt-1', 'user-1');
      expect(out.status).toBe('PROCESSED');
    });

    it('closes the waiting OUT from the IN that posted the transfer', async () => {
      const { service, repo, posting } = setup();
      repo.findEvent.mockResolvedValue({
        ...ROUTED,
        direction: 'IN',
        status: 'PROCESSED',
        statusReason: null,
        moneyEventType: 'transfer',
      });
      repo.findLateTransferPeer.mockResolvedValue({
        ...PEER,
        status: 'REVIEW',
        statusReason: 'TRANSFER_AWAITING_PEER',
        moneyEventId: null,
      });
      await service.ingest(CTX, VCB());
      expect(posting.post).toHaveBeenLastCalledWith(
        'hh-1',
        'evt-peer',
        'user-1',
      );
    });

    it('never pairs two posted transfers', async () => {
      const { service, repo } = setup();
      repo.findEvent.mockResolvedValue({
        ...ROUTED,
        direction: 'IN',
        status: 'PROCESSED',
        statusReason: null,
        moneyEventType: 'transfer',
      });
      repo.findLateTransferPeer
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          ...PEER,
          moneyEventId: 'me-0',
          moneyEventType: 'transfer',
        });
      await service.ingest(CTX, VCB());
      expect(repo.pairTransfer).not.toHaveBeenCalled();
    });
  });

  it('treats a lost pairing race as no peer', async () => {
    jest.useFakeTimers();
    const { service, repo, lastStatus } = setup();
    repo.hasOtherLinkedSource.mockResolvedValue(true);
    repo.findTransferPeer.mockResolvedValue({ ...PEER, moneyEventId: null });
    repo.pairTransfer.mockResolvedValue(false);
    await service.ingest(CTX, TCB_OUT);
    expect(lastStatus()).toMatchObject({
      statusReason: 'TRANSFER_AWAITING_PEER',
    });
    jest.useRealTimers();
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

describe('noteFromBody', () => {
  it('keeps the body but masks the full account number', () => {
    const body =
      'Tài khoản: 1903 5020 891016\nSố dư: VND 2,202,538\nMBVCB.16498389245 chuyen tien';
    const note = noteFromBody(body, '19035020891016');
    expect(note).toBe(
      'Tài khoản: ••1016\nSố dư: VND 2,202,538\nMBVCB.16498389245 chuyen tien',
    );
  });

  it('leaves the body untouched when no account was parsed', () => {
    expect(noteFromBody('  + VND 2,000  ', null)).toBe('+ VND 2,000');
  });
});
