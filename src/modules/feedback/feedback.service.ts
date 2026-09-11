import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { AuthUser } from '../auth/entities/auth-user.entity';
import { Feedback, FeedbackType } from './entities/feedback.entity';
import type { CreateFeedbackDto } from './dto/create-feedback.dto';
import { FEEDBACK_REPOSITORY } from './repositories/feedback.repository.interface';
import type { FeedbackRepository } from './repositories/feedback.repository.interface';

const FEEDBACK_TYPES: readonly FeedbackType[] = ['bug', 'idea', 'other'];

/** Matches the CHECK constraint in the migration. */
const MESSAGE_MAX = 2000;
const CONTEXT_MAX_BYTES = 4000;
/** Per-value cap — a user agent is long, a route is not. */
const CONTEXT_VALUE_MAX = 500;
const CONTEXT_MAX_KEYS = 20;

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_PER_WINDOW = 20;

function isFeedbackType(value: unknown): value is FeedbackType {
  return (
    typeof value === 'string' &&
    (FEEDBACK_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Keep only string/number/boolean leaves, trimmed and capped. Deliberately does
 * not know the key names — the bag is the client's vocabulary. It only ensures
 * nothing unbounded, nested, or non-primitive reaches the column.
 */
function sanitizeContext(
  context: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return {};
  }

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (Object.keys(clean).length >= CONTEXT_MAX_KEYS) break;

    if (typeof value === 'number' || typeof value === 'boolean') {
      clean[key] = value;
      continue;
    }
    if (typeof value !== 'string') continue;

    const trimmed = value.trim();
    if (!trimmed) continue;
    clean[key] = trimmed.slice(0, CONTEXT_VALUE_MAX);
  }

  if (JSON.stringify(clean).length > CONTEXT_MAX_BYTES) return {};
  return clean;
}

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger('FeedbackService');

  constructor(
    @Inject(FEEDBACK_REPOSITORY)
    private readonly repository: FeedbackRepository,
  ) {}

  async submitFeedback(user: AuthUser, payload: CreateFeedbackDto) {
    const type = payload.type?.trim();
    if (!isFeedbackType(type)) {
      throw new BadRequestException(
        `Feedback type must be one of: ${FEEDBACK_TYPES.join(', ')}.`,
      );
    }

    const message = payload.message?.trim();
    if (!message) {
      throw new BadRequestException('A feedback message is required.');
    }
    if (message.length > MESSAGE_MAX) {
      throw new BadRequestException(
        `Feedback message must be at most ${MESSAGE_MAX} characters.`,
      );
    }

    await this.assertNotFlooding(user.id);

    const feedback: Feedback = {
      id: this.repository.createId(),
      // From the token, never the body — the DTO has no user field.
      userId: user.id,
      type,
      message,
      email: user.email ?? null,
      householdId: payload.householdId?.trim() || null,
      context: sanitizeContext(payload.context),
      createdAt: new Date(),
    };

    await this.repository.insertFeedback(feedback);

    // One line, so a spike is visible without a read endpoint. The MESSAGE is
    // never logged — it is the user's own words, and the log is not where they
    // agreed to put them.
    this.logger.log(
      `feedback received type=${feedback.type} length=${message.length}`,
    );

    return { submitted: true as const, feedbackId: feedback.id };
  }

  /**
   * The only abuse control, deliberately loose: the endpoint is authenticated,
   * so the realistic failure is a client retry loop, not a person. A tight limit
   * would reject the second honest report of a bad afternoon.
   */
  private async assertNotFlooding(userId: string): Promise<void> {
    const since = new Date(Date.now() - RATE_WINDOW_MS);
    const recent = await this.repository.countRecentForUser(userId, since);
    if (recent >= RATE_MAX_PER_WINDOW) {
      throw new BadRequestException(
        'Too many reports submitted recently. Please try again later.',
      );
    }
  }
}
