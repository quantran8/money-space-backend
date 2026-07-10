import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AuthProvider, AuthUser } from './entities/auth-user.entity';

/**
 * Shape of the claims a Supabase-issued access token carries. We only rely on
 * the subset needed to build an {@link AuthUser}.
 */
interface SupabaseJwtPayload extends JWTPayload {
  email?: string;
  app_metadata?: { provider?: string };
  user_metadata?: {
    full_name?: string;
    name?: string;
    display_name?: string;
    avatar_url?: string;
    picture?: string;
  };
}

/**
 * Verifies Supabase access tokens locally using the project's JWKS endpoint,
 * with no per-request network call. `jose` caches the fetched signing keys and
 * only refetches when it sees an unknown key id, so the common path is pure CPU.
 *
 * This replaces `supabase.auth.getUser(token)`, which cost a full round-trip to
 * the Supabase Auth server (~200-670ms) on every authenticated request.
 */
@Injectable()
export class TokenVerifierService {
  private readonly logger = new Logger(TokenVerifierService.name);
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | null;
  private readonly issuer: string | undefined;

  constructor() {
    const jwksUrl = process.env.SUPABASE_JWKS_URL;
    const supabaseUrl = process.env.SUPABASE_URL;

    // Supabase issues tokens with `iss = <SUPABASE_URL>/auth/v1`.
    this.issuer = supabaseUrl ? `${supabaseUrl}/auth/v1` : undefined;
    this.jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null;

    if (!this.jwks) {
      this.logger.warn(
        'SUPABASE_JWKS_URL is not set; local token verification is disabled.',
      );
    }
  }

  /**
   * Whether local verification is available. When false, callers should fall
   * back to the network-based `AuthService.getUserFromToken`.
   */
  isEnabled(): boolean {
    return this.jwks !== null;
  }

  async verify(token: string): Promise<AuthUser> {
    if (!this.jwks) {
      throw new UnauthorizedException('Token verification is not configured');
    }

    let payload: SupabaseJwtPayload;
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        // Supabase access tokens use `aud: "authenticated"`.
        audience: 'authenticated',
      });
      payload = result.payload as SupabaseJwtPayload;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      throw new UnauthorizedException(`Invalid or expired session (${reason})`);
    }

    if (!payload.sub) {
      throw new UnauthorizedException('Token is missing a subject claim');
    }

    return this.toAuthUser(payload);
  }

  private toAuthUser(payload: SupabaseJwtPayload): AuthUser {
    const meta = payload.user_metadata ?? {};
    const provider: AuthProvider =
      payload.app_metadata?.provider === 'google' ? 'google' : 'email';

    const fullName = meta.full_name ?? meta.name ?? null;
    const displayName = meta.display_name ?? fullName ?? null;
    const avatarUrl = meta.avatar_url ?? meta.picture ?? null;

    return {
      id: payload.sub as string,
      email: payload.email ?? null,
      fullName,
      displayName,
      avatarUrl,
      provider,
    };
  }
}
