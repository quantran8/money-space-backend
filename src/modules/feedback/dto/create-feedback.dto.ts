/**
 * Plain interface — this repo hand-validates in the service (no class-validator,
 * no global ValidationPipe). Everything here is untrusted.
 *
 * There is deliberately NO user field: the reporter comes from the bearer token.
 */
export interface CreateFeedbackDto {
  /** 'bug' | 'idea' | 'other'. Checked in the service against FEEDBACK_TYPES. */
  type?: string;
  message?: string;
  /**
   * The space the reporter was looking at. A CONTEXT hint, never a scope —
   * nothing is ever looked up by it.
   */
  householdId?: string | null;
  /** Client-gathered context. Shape-checked and size-capped, not parsed. */
  context?: Record<string, unknown> | null;
}
