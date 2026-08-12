import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { InviteTokensController } from './invite-tokens.controller';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { INVITES_REPOSITORY } from './repositories/invites.repository.interface';
import { PrismaInvitesRepository } from './repositories/prisma-invites.repository';

/**
 * TWO controllers, deliberately. The inviter's routes are household-scoped and
 * admin-gated; the invitee's are keyed only by token and must carry no
 * `:householdId` (see `invite-tokens.controller.ts` for why).
 */
@Module({
  imports: [CommonModule],
  controllers: [InvitesController, InviteTokensController],
  providers: [
    InvitesService,
    {
      provide: INVITES_REPOSITORY,
      useClass: PrismaInvitesRepository,
    },
  ],
  exports: [InvitesService],
})
export class InvitesModule {}
