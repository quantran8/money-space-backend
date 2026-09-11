import { Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/entities/auth-user.entity';
import { FeedbackService } from './feedback.service';
import type { CreateFeedbackDto } from './dto/create-feedback.dto';

/**
 * `POST /api/v1/feedback` — the whole feature.
 *
 * NOT under `households/:householdId`: a report is one person's message, and the
 * report that matters most comes from someone who has no household yet. That
 * also means `HouseholdAccessGuard` passes through (it returns true for any
 * route with no `:householdId` param), so the actor comes from the token and
 * nothing in the body is trusted.
 *
 * There is no GET — submissions are read in the Supabase dashboard. See
 * memory/feedback.md.
 */
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly service: FeedbackService) {}

  @Post()
  submitFeedback(
    @CurrentUser() user: AuthUser | undefined,
    @Body() payload: CreateFeedbackDto,
  ) {
    // The global SupabaseAuthGuard already rejects an unauthenticated caller;
    // this narrows `AuthUser | undefined` for the service.
    if (!user) {
      throw new UnauthorizedException('Authentication is required.');
    }
    return this.service.submitFeedback(user, payload);
  }
}
