import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MembersService } from './members.service';
import type { MembersRepository } from './repositories/members.repository.interface';
import type { HouseholdMember } from './entities/member.entity';

const CREATOR_USER = 'user-an';
const PARTNER_USER = 'user-binh';
const HOUSEHOLD = 'hh-1';

const member = (over: Partial<HouseholdMember> = {}): HouseholdMember => ({
  id: 'm-partner',
  profileId: PARTNER_USER,
  householdId: HOUSEHOLD,
  name: 'Bình',
  email: 'binh@example.com',
  initials: 'B',
  role: 'partner',
  permission: 'edit_content',
  joinedAt: '2026-01-01',
  lastActive: '2026-01-01',
  status: 'active',
  ...over,
});

// An options bag, not a default parameter: `setup(undefined)` would trigger the
// default and hand back a real member, quietly defeating the not-found case.
function setup(rows: { found?: HouseholdMember } = { found: member() }) {
  const found = rows.found;
  const repository = {
    assertHousehold: jest.fn().mockResolvedValue({
      id: HOUSEHOLD,
      name: 'Gia đình',
      currency: 'VND',
      updateFrequency: 'monthly',
      config: {},
      createdBy: CREATOR_USER,
      createdAt: '2026-01-01',
    }),
    findMemberById: jest.fn().mockResolvedValue(found),
    deleteMember: jest.fn().mockResolvedValue(undefined),
  } as unknown as MembersRepository;

  return { service: new MembersService(repository), repository };
}

describe('MembersService.deleteMember', () => {
  it('removes an ordinary member', async () => {
    const { service, repository } = setup();

    await expect(service.deleteMember(HOUSEHOLD, 'm-partner')).resolves.toEqual(
      {
        deleted: true,
        memberId: 'm-partner',
      },
    );
    expect(repository.deleteMember).toHaveBeenCalledWith('m-partner');
  });

  /**
   * The lifecycle safeguard is anchored on `households.created_by`, and
   * `HouseholdAccessGuard` resolves it from a LIVE membership row. Removing the
   * creator's row would therefore leave a household where nobody can invite or
   * remove anyone, permanently. This is the check that makes that unreachable —
   * it is a structural guarantee, not a courtesy.
   */
  it('refuses to remove the member who created the household', async () => {
    const { service, repository } = setup({
      found: member({ id: 'm-creator', profileId: CREATOR_USER, name: 'An' }),
    });

    await expect(
      service.deleteMember(HOUSEHOLD, 'm-creator'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.deleteMember).not.toHaveBeenCalled();
  });

  /**
   * Anchored on `created_by`, NOT on `role`. A member still carrying
   * `role: 'owner'` from before the role column was retired is just a member.
   */
  it('does not treat a stale owner role as the safeguard', async () => {
    const { service, repository } = setup({
      found: member({
        id: 'm-old-owner',
        profileId: PARTNER_USER,
        role: 'owner',
      }),
    });

    await expect(
      service.deleteMember(HOUSEHOLD, 'm-old-owner'),
    ).resolves.toEqual({ deleted: true, memberId: 'm-old-owner' });
    expect(repository.deleteMember).toHaveBeenCalledWith('m-old-owner');
  });

  it('404s for a member that is not in this household', async () => {
    const { service } = setup({});

    await expect(
      service.deleteMember(HOUSEHOLD, 'm-nope'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
