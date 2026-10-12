import type { CacheInvalidator } from '../../../common/cache/cache-invalidator.service';
import type { MoneyEventsService } from '../../money-events/money-events.service';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';
import { BankPostingService } from './bank-posting.service';

const EVENT = {
  id: 'evt-1',
  householdId: 'hh-1',
  status: 'REVIEW',
  moneyEventId: null,
  matchedAssetId: 'wallet-1',
  amountMinor: 2000,
  direction: 'IN',
  transactionAt: new Date('2026-10-12T17:30:00Z'),
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

function setup(event: Record<string, unknown> = EVENT) {
  const repo = {
    lockEvent: jest.fn().mockResolvedValue(event),
    findWallet: jest.fn().mockResolvedValue(WALLET),
    updateEvent: jest.fn().mockResolvedValue(undefined),
  };
  const moneyEvents = {
    systemCategoryId: jest.fn().mockResolvedValue('cat-income'),
    createMoneyEvent: jest.fn().mockResolvedValue({}),
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
  );
  return { repo, moneyEvents, service };
}

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
