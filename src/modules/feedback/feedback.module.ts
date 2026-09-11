import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { FEEDBACK_REPOSITORY } from './repositories/feedback.repository.interface';
import { PrismaFeedbackRepository } from './repositories/prisma-feedback.repository';

@Module({
  imports: [CommonModule],
  controllers: [FeedbackController],
  providers: [
    FeedbackService,
    { provide: FEEDBACK_REPOSITORY, useClass: PrismaFeedbackRepository },
  ],
  exports: [FeedbackService],
})
export class FeedbackModule {}
