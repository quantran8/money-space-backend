import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:public';

/**
 * Marks a route as public — the global `SupabaseAuthGuard` skips authentication
 * for it (signup/login/google/refresh). Everything else requires a valid token.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
