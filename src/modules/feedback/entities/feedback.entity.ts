export type FeedbackType = 'bug' | 'idea' | 'other';

export interface Feedback {
  id: string;
  /** Always from the bearer token. */
  userId: string;
  type: FeedbackType;
  message: string;
  /** As the token carried it. Denormalized so a row reads without a join. */
  email: string | null;
  /** Hint only — no foreign key, may name a household that no longer exists. */
  householdId: string | null;
  context: Record<string, unknown>;
  createdAt: Date;
}
