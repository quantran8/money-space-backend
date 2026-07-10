import {
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Session, User } from '@supabase/supabase-js';
import { SupabaseService } from '../../database/supabase/supabase.service';
import type { GoogleCallbackDto } from './dto/google-auth.dto';
import type { LoginDto } from './dto/login.dto';
import type { RefreshTokenDto } from './dto/refresh-token.dto';
import type { SignupDto } from './dto/signup.dto';
import type {
  AuthProvider,
  AuthResult,
  AuthSession,
  AuthUser,
} from './entities/auth-user.entity';
import { AUTH_REPOSITORY } from './repositories/auth.repository.interface';
import type { AuthRepository } from './repositories/auth.repository.interface';
import { TokenVerifierService } from './token-verifier.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly tokenVerifier: TokenVerifierService,
    @Inject(AUTH_REPOSITORY)
    private readonly authRepository: AuthRepository,
  ) {}

  async signup(payload: SignupDto): Promise<AuthResult> {
    const email = payload.email.trim().toLowerCase();
    const fullName = payload.fullName?.trim();
    const displayName = payload.displayName?.trim() || fullName;

    const { data, error } = await this.client().auth.signUp({
      email,
      password: payload.password,
      options: {
        data: {
          full_name: fullName,
          display_name: displayName,
        },
      },
    });

    if (error) {
      throw new UnauthorizedException(error.message);
    }

    if (!data.user) {
      throw new InternalServerErrorException('Sign up did not return a user');
    }

    const user = this.mapUser(data.user, 'email');
    await this.authRepository.upsertProfile(user);

    // When email confirmation is enabled Supabase returns no session yet.
    return { user, session: this.mapSession(data.session) };
  }

  async login(payload: LoginDto): Promise<AuthResult> {
    const email = payload.email.trim().toLowerCase();

    const { data, error } = await this.client().auth.signInWithPassword({
      email,
      password: payload.password,
    });

    if (error) {
      throw new UnauthorizedException(error.message);
    }

    if (!data.user || !data.session) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const user = this.mapUser(data.user, 'email');
    await this.authRepository.upsertProfile(user);

    return { user, session: this.mapSession(data.session) };
  }

  /**
   * Build the Google OAuth authorization URL. The frontend redirects the user
   * to this URL; Supabase then redirects back to `redirectTo` with a `code`
   * that is exchanged via `googleCallback`.
   */
  async getGoogleAuthUrl(redirectTo?: string): Promise<{ url: string }> {
    const { data, error } = await this.client().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        skipBrowserRedirect: true,
      },
    });

    if (error || !data?.url) {
      throw new InternalServerErrorException(
        error?.message ?? 'Could not create Google sign-in URL',
      );
    }

    return { url: data.url };
  }

  async googleCallback(payload: GoogleCallbackDto): Promise<AuthResult> {
    const { data, error } = await this.client().auth.exchangeCodeForSession(
      payload.code,
    );

    if (error) {
      throw new UnauthorizedException(error.message);
    }

    if (!data.user || !data.session) {
      throw new UnauthorizedException('Could not complete Google sign-in');
    }

    const user = this.mapUser(data.user, 'google');
    await this.authRepository.upsertProfile(user);

    return { user, session: this.mapSession(data.session) };
  }

  async refresh(payload: RefreshTokenDto): Promise<AuthResult> {
    const { data, error } = await this.client().auth.refreshSession({
      refresh_token: payload.refreshToken,
    });

    if (error) {
      throw new UnauthorizedException(error.message);
    }

    if (!data.user || !data.session) {
      throw new UnauthorizedException('Could not refresh session');
    }

    return {
      user: this.mapUser(data.user, this.providerOf(data.user)),
      session: this.mapSession(data.session),
    };
  }

  async logout(accessToken: string): Promise<{ success: true }> {
    // Revoke the refresh tokens for this user via the admin API when possible,
    // otherwise fall back to signing out the anon client session.
    const { data, error } = await this.client().auth.getUser(accessToken);

    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    if (this.supabase.hasAdminClient()) {
      await this.supabase.getAdminClient().auth.admin.signOut(accessToken);
    }

    return { success: true };
  }

  /**
   * Validate a Supabase access token and return the authenticated user.
   * Used by `SupabaseAuthGuard` and `AuthMiddleware`.
   *
   * Prefers local JWKS verification (no network call). Falls back to the
   * Supabase Auth API only when JWKS verification is not configured.
   */
  async getUserFromToken(accessToken: string): Promise<AuthUser> {
    if (this.tokenVerifier.isEnabled()) {
      return this.tokenVerifier.verify(accessToken);
    }

    const { data, error } = await this.client().auth.getUser(accessToken);

    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    return this.mapUser(data.user, this.providerOf(data.user));
  }

  private client() {
    return this.supabase.getPublicClient();
  }

  private providerOf(user: User): AuthProvider {
    return user.app_metadata?.provider === 'google' ? 'google' : 'email';
  }

  private mapUser(user: User, provider: AuthProvider): AuthUser {
    const meta = user.user_metadata ?? {};
    const fullName =
      (meta.full_name as string | undefined) ??
      (meta.name as string | undefined) ??
      null;
    const displayName =
      (meta.display_name as string | undefined) ?? fullName ?? null;
    const avatarUrl =
      (meta.avatar_url as string | undefined) ??
      (meta.picture as string | undefined) ??
      null;

    return {
      id: user.id,
      email: user.email ?? null,
      fullName,
      displayName,
      avatarUrl,
      provider,
    };
  }

  private mapSession(session: Session | null): AuthSession | null {
    if (!session) {
      return null;
    }

    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresIn: session.expires_in,
      expiresAt: session.expires_at ?? null,
      tokenType: session.token_type,
    };
  }
}
