import type { AuthUser } from '../entities/auth-user.entity';

export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');

export interface AuthRepository {
  /**
   * Ensure a `profiles` row exists for the Supabase auth user and keep the
   * mirrored profile fields (email, name, avatar) in sync on every login.
   */
  upsertProfile(user: AuthUser): Promise<void>;
}
