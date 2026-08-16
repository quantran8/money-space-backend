import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HouseholdAccessGuard } from './household-access.guard';
import type { RequestWithMembership } from './household-access.guard';
import { HOUSEHOLD_CREATOR_KEY } from '../decorators/require-household-creator.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { PrismaService } from '../../../database/prisma/prisma.service';

const CREATOR = 'user-an';
const PARTNER = 'user-binh';
const HOUSEHOLD = 'hh-1';

type Rows = {
  household?: { id: string; createdById: string } | null;
  member?: { id: string } | null;
};

function setup(rows: Rows = {}) {
  // `in`, not `??` — an explicit `null` means "this row is absent", which is
  // the whole point of the 404 case.
  const household =
    'household' in rows
      ? rows.household
      : { id: HOUSEHOLD, createdById: CREATOR };
  const member = 'member' in rows ? rows.member : { id: 'm-1' };

  const prisma = {
    client: () => ({
      household: { findFirst: jest.fn().mockResolvedValue(household) },
      householdMember: { findFirst: jest.fn().mockResolvedValue(member) },
    }),
  } as unknown as PrismaService;

  const reflector = new Reflector();
  const guard = new HouseholdAccessGuard(prisma, reflector);

  const run = (
    userId: string | null,
    opts: {
      creatorOnly?: boolean;
      isPublic?: boolean;
      householdId?: string;
    } = {},
  ) => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: unknown) => {
        if (key === IS_PUBLIC_KEY) return opts.isPublic;
        if (key === HOUSEHOLD_CREATOR_KEY) return opts.creatorOnly;
        return undefined;
      });

    const request: RequestWithMembership = {
      headers: {},
      params:
        'householdId' in opts
          ? opts.householdId === undefined
            ? {}
            : { householdId: opts.householdId }
          : { householdId: HOUSEHOLD },
      user: userId ? ({ id: userId } as never) : undefined,
    };

    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;

    return { promise: guard.canActivate(context), request };
  };

  return { run };
}

describe('HouseholdAccessGuard', () => {
  describe('membership is the content permission', () => {
    it('lets any live member through, creator or not', async () => {
      const { run } = setup();
      await expect(run(PARTNER).promise).resolves.toBe(true);
    });

    it('attaches the membership, flagging only who created the household', async () => {
      const { run } = setup();

      const partner = run(PARTNER);
      await partner.promise;
      expect(partner.request.membership).toEqual({
        memberId: 'm-1',
        householdId: HOUSEHOLD,
        userId: PARTNER,
        isCreator: false,
      });

      const creator = run(CREATOR);
      await creator.promise;
      expect(creator.request.membership?.isCreator).toBe(true);
    });

    it('rejects someone who is not a member', async () => {
      const { run } = setup({ member: null });
      await expect(run('user-stranger').promise).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects a request with no authenticated user', async () => {
      const { run } = setup();
      await expect(run(null).promise).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('skips routes that are not household-scoped', async () => {
      const { run } = setup({ household: null, member: null });
      await expect(
        run(PARTNER, { householdId: undefined }).promise,
      ).resolves.toBe(true);
    });

    it('skips public routes before touching the database', async () => {
      const { run } = setup({ household: null, member: null });
      await expect(run(null, { isPublic: true }).promise).resolves.toBe(true);
    });
  });

  /**
   * Load-bearing and previously untested: a missing household must 404 even
   * when the caller is also not a member. Returning 403 first would let anyone
   * probe which household ids exist by reading the status code.
   */
  describe('a missing household is a 404, never a 403', () => {
    it('404s for a non-member asking about a household that does not exist', async () => {
      const { run } = setup({ household: null, member: null });
      await expect(run('user-stranger').promise).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('@RequireHouseholdCreator', () => {
    it('lets the creator through', async () => {
      const { run } = setup();
      await expect(run(CREATOR, { creatorOnly: true }).promise).resolves.toBe(
        true,
      );
    });

    it('rejects a member who did not create the household', async () => {
      const { run } = setup();
      await expect(
        run(PARTNER, { creatorOnly: true }).promise,
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('does not restrict routes that omit the marker', async () => {
      const { run } = setup();
      await expect(
        run(PARTNER, { creatorOnly: undefined }).promise,
      ).resolves.toBe(true);
    });
  });
});
