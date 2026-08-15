import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InvitesService } from './invites.service';
import type { HouseholdInvite } from './entities/invite.entity';

const DAY_MS = 24 * 60 * 60 * 1000;

function invite(over: Partial<HouseholdInvite> = {}): HouseholdInvite {
  return {
    id: 'inv-1',
    householdId: 'hh-1',
    invitedById: 'user-owner',
    inviteeEmail: 'partner@example.com',
    inviteePhone: null,
    token: 'tok-1',
    status: 'pending',
    defaultRole: 'partner',
    defaultPermissionLevel: null,
    expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
    acceptedById: null,
    acceptedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

const USER = {
  id: 'user-invitee',
  email: 'partner@example.com',
  fullName: 'Partner',
  displayName: null,
  avatarUrl: null,
  provider: 'email' as const,
};

// `null` means "no such token". Not `undefined` — that would re-trigger the
// default parameter and silently hand the test a real invite.
function setup(stored: HouseholdInvite | null = invite()) {
  const invitesRepository = {
    assertHousehold: jest.fn(async () => ({ id: 'hh-1' })),
    createId: jest.fn(() => 'inv-new'),
    createToken: jest.fn(() => 'tok-new'),
    findInvitesByHousehold: jest.fn(async () => (stored ? [stored] : [])),
    findInviteById: jest.fn(async () => stored ?? undefined),
    findInviteByToken: jest.fn(async () => stored ?? undefined),
    findInviteContext: jest.fn(async () => ({
      householdName: 'Nhà mình',
      invitedByName: 'Owner',
    })),
    insertInvite: jest.fn(async () => undefined),
    revokeInvite: jest.fn(async () => undefined),
    acceptInvite: jest.fn(async () => ({
      householdId: 'hh-1',
      memberId: 'mem-1',
      alreadyMember: false,
    })),
  } as never;

  return {
    service: new InvitesService(invitesRepository),
    invitesRepository: invitesRepository as Record<string, jest.Mock>,
  };
}

describe('InvitesService.previewInvite', () => {
  /**
   * The holder of a token is not a member and has been granted nothing. The
   * preview must answer "who is asking me to join, and as what" — and nothing
   * about the household's money.
   */
  it('reveals no financial data', async () => {
    const { service } = setup();

    const preview = await service.previewInvite('tok-1');

    expect(Object.keys(preview).sort()).toEqual([
      'acceptable',
      'defaultRole',
      'expiresAt',
      'householdName',
      'invitedByName',
      'status',
    ]);
  });

  /**
   * The row is only updated lazily, so a long-untouched invite still reads
   * `pending` in the database. The timestamp is the truth.
   */
  it('reports an elapsed invite as expired even while stored as pending', async () => {
    const { service } = setup(
      invite({ expiresAt: new Date(Date.now() - DAY_MS).toISOString() }),
    );

    const preview = await service.previewInvite('tok-1');

    expect(preview.status).toBe('expired');
    expect(preview.acceptable).toBe(false);
  });

  /** Distinguishing "no such token" from "deleted household" would let anyone
   *  probe which tokens ever existed. */
  it('404s on an unknown token', async () => {
    const { service } = setup(null);
    await expect(service.previewInvite('nope')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('InvitesService.acceptInvite', () => {
  it('joins the household with the invited role', async () => {
    const { service, invitesRepository } = setup();

    const result = await service.acceptInvite('tok-1', USER);

    expect(result).toEqual({
      householdId: 'hh-1',
      memberId: 'mem-1',
      role: 'partner',
      alreadyMember: false,
    });
    expect(invitesRepository.acceptInvite).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inv-1' }),
      expect.objectContaining({ id: 'user-invitee' }),
    );
  });

  /**
   * Joining attaches a real identity to a real member row, so we must know who
   * is joining. Prior MEMBERSHIP is what cannot be required — that's the state
   * they're trying to leave.
   */
  it('requires authentication', async () => {
    const { service } = setup();
    await expect(service.acceptInvite('tok-1', undefined)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it.each([
    ['already used', invite({ status: 'accepted' })],
    ['withdrawn', invite({ status: 'cancelled' })],
    [
      'expired',
      invite({ expiresAt: new Date(Date.now() - DAY_MS).toISOString() }),
    ],
  ])('refuses an invite that is %s', async (_label, stored) => {
    const { service, invitesRepository } = setup(stored);

    await expect(service.acceptInvite('tok-1', USER)).rejects.toThrow(
      BadRequestException,
    );
    expect(invitesRepository.acceptInvite).not.toHaveBeenCalled();
  });
});

describe('InvitesService.createInvite', () => {
  it('mints a token and defaults to a 14-day partner invite', async () => {
    const { service } = setup();

    const created = await service.createInvite('hh-1', {}, USER);

    expect(created.token).toBe('tok-new');
    expect(created.defaultRole).toBe('partner');
    // NULL permission is meaningful: it derives from the role, so a later
    // change to the role's default reaches this member too.
    expect(created.defaultPermissionLevel).toBeNull();
    const days = Math.round(
      (new Date(created.expiresAt).getTime() - Date.now()) / DAY_MS,
    );
    expect(days).toBe(14);
  });

  it.each([['not-an-email'], ['a@b'], ['@example.com']])(
    'rejects the invalid email %s',
    async (email) => {
      const { service } = setup();
      await expect(
        service.createInvite('hh-1', { inviteeEmail: email }, USER),
      ).rejects.toThrow(BadRequestException);
    },
  );

  it.each([[0], [-1], [365]])('rejects an expiry of %s days', async (days) => {
    const { service } = setup();
    await expect(
      service.createInvite('hh-1', { expiresInDays: days }, USER),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('InvitesService.revokeInvite', () => {
  /** The person did join. Revoking afterwards would misrepresent history. */
  it('refuses to revoke an accepted invite', async () => {
    const { service } = setup(invite({ status: 'accepted' }));
    await expect(service.revokeInvite('hh-1', 'inv-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('revokes a pending one', async () => {
    const { service, invitesRepository } = setup();
    await expect(service.revokeInvite('hh-1', 'inv-1')).resolves.toEqual({
      revoked: true,
      inviteId: 'inv-1',
    });
    expect(invitesRepository.revokeInvite).toHaveBeenCalledWith('inv-1');
  });
});
