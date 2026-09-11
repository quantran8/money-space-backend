import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from '../../../common/utils/uuid';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Feedback } from '../entities/feedback.entity';
import { FeedbackRepository } from './feedback.repository.interface';

@Injectable()
export class PrismaFeedbackRepository
  extends PrismaRepository
  implements FeedbackRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  createId(): string {
    return uuidv7();
  }

  async insertFeedback(feedback: Feedback): Promise<void> {
    await this.prisma.feedback.create({
      data: {
        id: feedback.id,
        userId: feedback.userId,
        type: feedback.type,
        message: feedback.message,
        email: feedback.email,
        // `asUuid` returns null for anything that is not a uuid, so a malformed
        // hint becomes "no hint" instead of a 500 on a uuid-typed column.
        householdId: this.asUuid(feedback.householdId),
        context: feedback.context as Prisma.InputJsonValue,
      },
    });
  }

  async countRecentForUser(userId: string, since: Date): Promise<number> {
    return this.prisma.feedback.count({
      where: { userId, createdAt: { gte: since } },
    });
  }
}
