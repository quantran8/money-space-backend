import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { MEMBERS_REPOSITORY } from './repositories/members.repository.interface';
import { PrismaMembersRepository } from './repositories/prisma-members.repository';

@Module({
  imports: [CommonModule],
  controllers: [MembersController],
  providers: [
    MembersService,
    {
      provide: MEMBERS_REPOSITORY,
      useClass: PrismaMembersRepository,
    },
  ],
  exports: [MembersService],
})
export class MembersModule {}
