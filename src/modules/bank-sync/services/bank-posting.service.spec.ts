import type { CacheInvalidator } from '../../../common/cache/cache-invalidator.service';
import type { CashflowSettlementService } from '../../cashflow-events/services/cashflow-settlement.service';
import type { AssetsService } from '../../assets/assets.service';
import type { MoneyEventsService } from '../../money-events/money-events.service';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';
import { BankPostingService, moneyEventNote } from './bank-posting.service';

const EVENT = {
  id: 'evt-1',
  householdId: 'hh-1',
  status: 'REVIEW',
  moneyEventId: null,
  matchedAssetId: 'wallet-1',
  amountMinor: 2000,
  direction: 'IN',
  transactionAt: new Date('2026-10-12T17:30:00Z'),
  description: 'Tài khoản: ••1016\nSố dư: VND 2,202,538',
  notificationAt: null,
  receivedAt: new Date(),
};
const WALLET = {
  id: 'wallet-1',
  name: 'VCB',
  type: 'bank_account',
  status: 'active',
  deletedAt: null,
};

function setup(
  event: Record<string, unknown> = EVENT,
  others: Array<Record<string, unknown>> = [],
) {
  const rows = new Map(
    [{ transferPeerEventId: null, ...event }, ...others].map((r) => [
      r.id as string,
      r,
    ]),
  );
  const repo = {
    findEvent: jest.fn((_hh: string, id: string) =>
      Promise.resolve(rows.get(id) ?? null),
    ),
    lockEvent: jest.fn((id: string) => Promise.resolve(rows.get(id) ?? null)),
    findWallet: jest.fn((_hh: string, id: string) =>
      Promise.resolve({ ...WALLET, id }),
    ),
    findSource: jest
      .fn()
      .mockResolvedValue({ id: 'src-tcb', status: 'ACTIVE' }),
    findLinksAt: jest.fn().mockResolvedValue([{ assetId: 'wallet-tcb' }]),
    updateEvent: jest.fn().mockResolvedValue(undefined),
    findLatestBalanceObservations: jest.fn().mockResolvedValue([]),
  };
  const assets = { syncWalletBalance: jest.fn().mockResolvedValue(undefined) };
  const moneyEvents = {
    systemCategoryId: jest.fn().mockResolvedValue('cat-income'),
    createMoneyEvent: jest.fn().mockResolvedValue({ id: 'me-1' }),
    getMoneyEvent: jest.fn(),
    updateMoneyEvent: jest.fn().mockResolvedValue({}),
  };
  const settlement = {
    settleExisting: jest.fn().mockResolvedValue({}),
    replaceManualWithBank: jest.fn().mockResolvedValue({}),
  };
  const cache = {
    runInTransactionAndInvalidate: jest.fn(
      (_hh: string, work: () => Promise<unknown>) => work(),
    ),
  };
  const service = new BankPostingService(
    repo as unknown as BankSyncRepository,
    moneyEvents as unknown as MoneyEventsService,
    cache as unknown as CacheInvalidator,
    settlement as unknown as CashflowSettlementService,
    assets as unknown as AssetsService,
  );
  return { repo, moneyEvents, settlement, assets, service };
}

describe('BankPostingService.post with settlement', () => {
  it('settles the chosen occurrence with the money event it just posted', async () => {
    const { service, settlement } = setup();
    await service.post('hh-1', 'evt-1', 'user-1', undefined, {
      kind: 'link',
      cashflowEventId: 'cf-1',
      via: 'manual_link',
    });
    expect(settlement.settleExisting).toHaveBeenCalledWith(
      'hh-1',
      'cf-1',
      'me-1',
      'manual_link',
      'user-1',
      null,
    );
  });

  it('replaces a manual completion instead of linking a second one', async () => {
    const { service, settlement } = setup();
    await service.post('hh-1', 'evt-1', 'user-1', undefined, {
      kind: 'replace_manual',
      cashflowEventId: 'cf-1',
    });
    expect(settlement.replaceManualWithBank).toHaveBeenCalledWith(
      'hh-1',
      'cf-1',
      'me-1',
      'user-1',
    );
    expect(settlement.settleExisting).not.toHaveBeenCalled();
  });
});

describe('BankPostingService.post', () => {
  it('records income into the wallet on the Vietnam-time date', async () => {
    const { service, moneyEvents, repo } = setup();
    await expect(service.post('hh-1', 'evt-1', 'user-1')).resolves.toBe(
      'posted',
    );
    expect(moneyEvents.createMoneyEvent).toHaveBeenCalledWith(
      'hh-1',
      expect.objectContaining({
        amount: 2000,
        type: 'income',
        direction: 'inflow',
        toAssetId: 'wallet-1',
        fromAssetId: undefined,
        isoDate: '2026-10-13',
        note: 'Tài khoản: ••1016\nSố dư: VND 2,202,538',
      }),
      {
        actorId: 'user-1',
        origin: 'bank_notification',
        notificationEventId: 'evt-1',
      },
    );
    expect(repo.updateEvent).toHaveBeenCalledWith(
      'evt-1',
      expect.objectContaining({ status: 'PROCESSED', processedById: 'user-1' }),
    );
  });

  it('debits the wallet for OUT', async () => {
    const { service, moneyEvents } = setup({ ...EVENT, direction: 'OUT' });
    await service.post('hh-1', 'evt-1', 'user-1');
    expect(moneyEvents.systemCategoryId).toHaveBeenCalledWith('hh-1', 'other');
    expect(moneyEvents.createMoneyEvent).toHaveBeenCalledWith(
      'hh-1',
      expect.objectContaining({
        type: 'expense',
        fromAssetId: 'wallet-1',
        toAssetId: undefined,
      }),
      expect.anything(),
    );
  });

  it('is a no-op for an event already posted', async () => {
    const { service, moneyEvents } = setup({
      ...EVENT,
      status: 'PROCESSED',
      moneyEventId: 'me-1',
    });
    await expect(service.post('hh-1', 'evt-1', 'user-1')).resolves.toBe(
      'already_posted',
    );
    expect(moneyEvents.createMoneyEvent).not.toHaveBeenCalled();
  });

  it('treats a lost race on the unique index as already posted', async () => {
    const { service, moneyEvents } = setup();
    moneyEvents.createMoneyEvent.mockRejectedValue({ code: 'P2002' });
    await expect(service.post('hh-1', 'evt-1', 'user-1')).resolves.toBe(
      'already_posted',
    );
  });

  it('refuses an event from another household', async () => {
    const { service } = setup({ ...EVENT, householdId: 'hh-2' });
    await expect(service.post('hh-1', 'evt-1', 'user-1')).rejects.toThrow(
      'not found',
    );
  });

  it('refuses a non-wallet target', async () => {
    const { service, repo, moneyEvents } = setup();
    repo.findWallet.mockResolvedValue({ ...WALLET, type: 'gold' });
    await expect(service.post('hh-1', 'evt-1', 'user-1')).rejects.toThrow(
      'active wallet',
    );
    expect(moneyEvents.createMoneyEvent).not.toHaveBeenCalled();
  });

  it('refuses an ignored event', async () => {
    const { service } = setup({ ...EVENT, status: 'IGNORED' });
    await expect(service.post('hh-1', 'evt-1', 'user-1')).rejects.toThrow(
      'IGNORED',
    );
  });
});

describe('moneyEventNote', () => {
  it('keeps only the TCB description line, without the reference', () => {
    const description =
      'Tài khoản: ••1016\nSố dư: VND 2,177,538\nAn sang. Ma tham chieu 053248';
    expect(moneyEventNote('TECHCOMBANK', description)).toBe('An sang');
  });

  it('keeps the whole TCB last line when it has no reference', () => {
    const description =
      'Tài khoản: ••1016\nSố dư: VND 2,190,538\nNGUYEN VAN A chuyen tien';
    expect(moneyEventNote('TECHCOMBANK', description)).toBe(
      'NGUYEN VAN A chuyen tien',
    );
  });

  it('keeps the VCB content between Ref and the FT trace', () => {
    const description =
      'Số dư TK VCB ••3153 +2,000 VND lúc 13-10-2026 08:32:04. Số dư 24,036,118 VND. Ref 6286IBT1k251RYXP.NGUYEN VAN A chuyen FT26286873025088.20261013.083204.19031234567801.VND-TGTT-NGUYEN VAN A.970407';
    expect(moneyEventNote('VCB', description)).toBe('NGUYEN VAN A chuyen');
  });

  it('keeps the VCB content when there is no FT trace', () => {
    const description =
      'Số dư TK VCB ••6789 +2,000 VND lúc 12-10-2026 14:44:34. Số dư 24,056,118 VND. Ref EXAMPLE123 chuyen tien 500,000';
    expect(moneyEventNote('VCB', description)).toBe('chuyen tien 500,000');
  });

  it('keeps the full VCB description when it has no Ref', () => {
    expect(moneyEventNote('VCB', 'Số dư TK VCB ••6789 +2,000 VND')).toBe(
      'Số dư TK VCB ••6789 +2,000 VND',
    );
  });
});

describe('BankPostingService.post own-account transfer', () => {
  const OUT_LEG = {
    ...EVENT,
    id: 'evt-0',
    direction: 'OUT',
    matchedAssetId: 'wallet-tcb',
    providerCode: 'TECHCOMBANK',
    description: 'Tài khoản: ••1016\nSố dư: VND 1\nChuyen tien sang VCB',
    transactionAt: null,
    notificationAt: new Date('2026-10-12T17:31:00Z'),
  };

  it('posts a counterpart-named IN as a transfer before the OUT arrives', async () => {
    const { service, moneyEvents } = setup({
      ...EVENT,
      counterpartSourceId: 'src-tcb',
    });
    await service.post('hh-1', 'evt-1', 'user-1');
    expect(moneyEvents.createMoneyEvent).toHaveBeenCalledWith(
      'hh-1',
      expect.objectContaining({
        type: 'transfer',
        direction: 'neutral',
        fromAssetId: 'wallet-tcb',
        toAssetId: 'wallet-1',
      }),
      expect.objectContaining({ notificationEventId: 'evt-1' }),
    );
  });

  it('creates one transfer for both legs and closes the waiting one', async () => {
    const { service, moneyEvents, repo } = setup(
      { ...OUT_LEG, transferPeerEventId: 'evt-1' },
      [{ ...EVENT, transferPeerEventId: 'evt-0' }],
    );
    await service.post('hh-1', 'evt-0', 'user-1');
    expect(moneyEvents.createMoneyEvent).toHaveBeenCalledTimes(1);
    expect(moneyEvents.createMoneyEvent).toHaveBeenCalledWith(
      'hh-1',
      expect.objectContaining({
        fromAssetId: 'wallet-tcb',
        toAssetId: 'wallet-1',
        note: 'Chuyen tien sang VCB',
        isoDate: '2026-10-13',
      }),
      expect.anything(),
    );
    expect(repo.updateEvent).toHaveBeenCalledWith(
      'evt-1',
      expect.objectContaining({
        status: 'PROCESSED',
        statusReason: 'TRANSFER_PAIRED',
      }),
    );
  });

  it('only closes the pair when the other leg already posted the transfer', async () => {
    const { service, moneyEvents, repo } = setup(
      { ...EVENT, transferPeerEventId: 'evt-0' },
      [{ ...OUT_LEG, transferPeerEventId: 'evt-1', moneyEventId: 'me-0' }],
    );
    moneyEvents.getMoneyEvent.mockResolvedValue({
      type: 'transfer',
      fromAssetId: 'wallet-tcb',
      toAssetId: 'wallet-1',
    });
    await service.post('hh-1', 'evt-1', 'user-1');
    expect(moneyEvents.createMoneyEvent).not.toHaveBeenCalled();
    expect(moneyEvents.updateMoneyEvent).not.toHaveBeenCalled();
    expect(repo.updateEvent).toHaveBeenCalledWith(
      'evt-1',
      expect.objectContaining({ statusReason: 'TRANSFER_PAIRED' }),
    );
  });

  it('turns an income the IN leg already posted into the transfer', async () => {
    const { service, moneyEvents } = setup(
      { ...OUT_LEG, transferPeerEventId: 'evt-1' },
      [{ ...EVENT, transferPeerEventId: 'evt-0', moneyEventId: 'me-1' }],
    );
    moneyEvents.getMoneyEvent.mockResolvedValue({
      type: 'income',
      fromAssetId: undefined,
      toAssetId: 'wallet-1',
    });
    await service.post('hh-1', 'evt-0', 'user-1');
    expect(moneyEvents.createMoneyEvent).not.toHaveBeenCalled();
    expect(moneyEvents.updateMoneyEvent).toHaveBeenCalledWith('hh-1', 'me-1', {
      type: 'transfer',
      direction: 'neutral',
      categoryId: 'cat-income',
      fromAssetId: 'wallet-tcb',
      toAssetId: 'wallet-1',
    });
  });

  it('refuses to settle a cashflow event with a transfer', async () => {
    const { service } = setup({ ...EVENT, counterpartSourceId: 'src-tcb' });
    await expect(
      service.post('hh-1', 'evt-1', 'user-1', undefined, {
        kind: 'link',
        cashflowEventId: 'cf-1',
        via: 'manual_link',
      }),
    ).rejects.toThrow('transfer');
  });
});

describe('BankPostingService.post balance sync', () => {
  const observation = (
    assetId: string,
    reported: number,
    current: number,
    superseded = false,
  ) => ({
    assetId,
    bankEventId: 'evt-1',
    reportedBalance: reported,
    currentValue: current,
    superseded,
  });

  it('sets the wallet to the bank-reported balance after posting', async () => {
    const { service, repo, assets } = setup();
    repo.findLatestBalanceObservations.mockResolvedValue([
      observation('wallet-1', 5000, 4200),
      observation('wallet-other', 100, 0),
    ]);
    await service.post('hh-1', 'evt-1', 'user-1');
    expect(assets.syncWalletBalance).toHaveBeenCalledTimes(1);
    expect(assets.syncWalletBalance).toHaveBeenCalledWith(
      'hh-1',
      'wallet-1',
      5000,
    );
  });

  it('skips a balance a later movement on the wallet replaced', async () => {
    const { service, repo, assets } = setup();
    repo.findLatestBalanceObservations.mockResolvedValue([
      observation('wallet-1', 5000, 4200, true),
    ]);
    await service.post('hh-1', 'evt-1', 'user-1');
    expect(assets.syncWalletBalance).not.toHaveBeenCalled();
  });

  it('leaves an agreeing wallet alone', async () => {
    const { service, repo, assets } = setup();
    repo.findLatestBalanceObservations.mockResolvedValue([
      observation('wallet-1', 4200, 4200),
    ]);
    await service.post('hh-1', 'evt-1', 'user-1');
    expect(assets.syncWalletBalance).not.toHaveBeenCalled();
  });
});
