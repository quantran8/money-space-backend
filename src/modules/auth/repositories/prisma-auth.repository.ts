import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { AuthUser } from '../entities/auth-user.entity';
import { AuthRepository } from './auth.repository.interface';

@Injectable()
export class PrismaAuthRepository
  extends PrismaRepository
  implements AuthRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async upsertProfile(user: AuthUser): Promise<void> {
    await this.prisma.profile.upsert({
      where: { id: user.id },
      update: {
        email: user.email,
        fullName: user.fullName,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      } as any,
      create: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      } as any,
    });
  }
}
