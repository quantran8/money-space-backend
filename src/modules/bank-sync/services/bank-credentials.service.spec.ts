import { generateIngestToken } from '../domain/ingest-token';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';
import { BankCredentialsService } from './bank-credentials.service';

const NOW = new Date('2026-10-12T08:00:00Z');
const CRED = {
  id: 'cred-1',
  userId: 'user-1',
  householdId: 'hh-1',
  deviceLabel: 'iPhone',
  tokenPrefix: 'msk_live_abcd',
  status: 'ACTIVE',
  expiresAt: null,
  lastUsedAt: null,
  createdAt: NOW,
  revokedAt: null,
};

function setup(
  credential: Record<string, unknown> | null = CRED,
  member = true,
) {
  const repo = {
    createId: jest.fn(() => 'cred-new'),
    findCredentialByHash: jest.fn().mockResolvedValue(credential),
    isLiveMember: jest.fn().mockResolvedValue(member),
    touchCredential: jest.fn().mockResolvedValue(undefined),
    listCredentials: jest.fn().mockResolvedValue([]),
    insertCredential: jest.fn().mockResolvedValue(undefined),
  };
  const service = new BankCredentialsService(
    repo as unknown as BankSyncRepository,
  );
  return { repo, service };
}

describe('BankCredentialsService.authenticate', () => {
  const { token } = generateIngestToken();

  it('resolves the owner from the token alone', async () => {
    const { service, repo } = setup();
    await expect(service.authenticate(token, NOW)).resolves.toEqual({
      credentialId: 'cred-1',
      userId: 'user-1',
      householdId: 'hh-1',
    });
    expect(repo.touchCredential).toHaveBeenCalled();
  });

  it('rejects a malformed token before touching the database', async () => {
    const { service, repo } = setup();
    await expect(
      service.authenticate('eyJhbGciOi.jwt.token', NOW),
    ).resolves.toBeNull();
    expect(repo.findCredentialByHash).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked', { ...CRED, status: 'REVOKED' }],
    ['expired', { ...CRED, expiresAt: new Date('2026-10-01') }],
    ['unknown', null],
  ])('rejects a %s credential', async (_name, credential) => {
    const { service } = setup(credential);
    await expect(service.authenticate(token, NOW)).resolves.toBeNull();
  });

  it('rejects once the owner has left the household', async () => {
    const { service } = setup(CRED, false);
    await expect(service.authenticate(token, NOW)).resolves.toBeNull();
  });

  it('does not write last_used_at on every request', async () => {
    const { service, repo } = setup({
      ...CRED,
      lastUsedAt: new Date(NOW.getTime() - 60_000),
    });
    await service.authenticate(token, NOW);
    expect(repo.touchCredential).not.toHaveBeenCalled();
  });
});

describe('BankCredentialsService.create', () => {
  it('returns the raw token once and stores only its hash', async () => {
    const { service, repo } = setup();
    const result = await service.create('hh-1', 'user-1', {
      deviceLabel: 'iPhone cá nhân',
    });
    const [[stored]] = repo.insertCredential.mock.calls as unknown as [
      [{ tokenHash: string }],
    ];
    expect(result.token.startsWith('msk_live_')).toBe(true);
    expect(stored.tokenHash).not.toContain(result.token);
    expect(JSON.stringify(result.credential)).not.toContain(result.token);
  });

  it('requires a device label', async () => {
    const { service } = setup();
    await expect(
      service.create('hh-1', 'user-1', { deviceLabel: '  ' }),
    ).rejects.toThrow();
  });
});
