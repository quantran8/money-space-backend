import type { Feedback } from '../entities/feedback.entity';

export const FEEDBACK_REPOSITORY = Symbol('FEEDBACK_REPOSITORY');

export interface FeedbackRepository {
  createId(): string;
  insertFeedback(feedback: Feedback): Promise<void>;
  /** How many reports this user filed since `since` — the abuse backstop. */
  countRecentForUser(userId: string, since: Date): Promise<number>;
}
