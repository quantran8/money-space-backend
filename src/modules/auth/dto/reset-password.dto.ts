export interface RequestPasswordResetDto {
  email: string;
  /**
   * Absolute URL Supabase sends the user back to, carrying the recovery token.
   * Optional: the project's configured Site URL is the fallback.
   */
  redirectTo?: string;
}

export interface UpdatePasswordDto {
  /** The `access_token` from the recovery link, not a normal session token. */
  accessToken: string;
  password: string;
}
