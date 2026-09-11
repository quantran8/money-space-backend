import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Session, User } from '@supabase/supabase-js';
import {
  CodedException,
  UnauthenticatedException,
} from '../../common/errors/coded.exceptions';
import {
  OAUTH_VERIFIER_ITEM,
  SupabaseService,
} from '../../database/supabase/supabase.service';
import type { GoogleCallbackDto } from './dto/google-auth.dto';
import type { LoginDto } from './dto/login.dto';
import type { RefreshTokenDto } from './dto/refresh-token.dto';
import type {
  RequestPasswordResetDto,
  UpdatePasswordDto,
} from './dto/reset-password.dto';
import type { SignupDto } from './dto/signup.dto';
import type {
  AuthProvider,
  AuthResult,
  AuthSession,
  AuthUser,
} from './entities/auth-user.entity';
import { AUTH_REPOSITORY } from './repositories/auth.repository.interface';
import type { AuthRepository } from './repositories/auth.repository.interface';
import { OauthVerifierStore } from './oauth-verifier.store';
import { TokenVerifierService } from './token-verifier.service';

/** Long enough for a real sign-in, short enough that a leaked code is stale. */
const GOOGLE_VERIFIER_TTL_SECONDS = 600;

function verifierKey(state: string) {
  return `oauth:pkce:${state}`;
}

/** Adds `state` to the callback URL, leaving any existing `next` intact. */
function withState(redirectTo: string | undefined, state: string) {
  if (!redirectTo) return undefined;
  try {
    const url = new URL(redirectTo);
    url.searchParams.set('state', state);
    return url.toString();
  } catch {
    throw new BadRequestException('redirectTo must be an absolute URL');
  }
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    private readonly supabase: SupabaseService,
    private readonly tokenVerifier: TokenVerifierService,
    private readonly verifiers: OauthVerifierStore,
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
      this.logger.warn(`signup failed: ${error.message}`);
      throw new UnauthenticatedException('Could not sign up');
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
      // Supabase's wording never leaves the process: it distinguishes "no such
      // user" from "wrong password", which is an account-enumeration oracle.
      this.logger.warn(`login failed: ${error.message}`);
      throw new UnauthenticatedException(
        'Invalid email or password',
        'invalid_credentials',
      );
    }

    if (!data.user || !data.session) {
      throw new UnauthenticatedException(
        'Invalid email or password',
        'invalid_credentials',
      );
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
    // supabase-js emits no OAuth `state`, so we mint one and carry it on the
    // callback URL — Supabase preserves the query string of `redirectTo`, and
    // it is what lets the callback find this verifier again.
    const state = randomUUID();
    const callbackUrl = withState(redirectTo, state);

    // Captures the code_verifier supabase-js mints while building the URL.
    let verifier: string | undefined;
    const client = this.supabase.getOAuthClient({
      getItem: () => null,
      setItem: (key, value) => {
        if (key === OAUTH_VERIFIER_ITEM) verifier = value;
      },
      removeItem: () => {},
    });

    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: callbackUrl,
        skipBrowserRedirect: true,
      },
    });

    if (error || !data?.url) {
      if (error) this.logger.warn(`google sign-in url failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Could not create Google sign-in URL',
      );
    }

    if (!verifier) {
      throw new InternalServerErrorException(
        'Google sign-in URL carried no PKCE verifier',
      );
    }

    await this.verifiers.set(
      verifierKey(state),
      verifier,
      GOOGLE_VERIFIER_TTL_SECONDS,
    );

    return { url: data.url };
  }

  async googleCallback(payload: GoogleCallbackDto): Promise<AuthResult> {
    if (!payload.state) {
      throw new UnauthorizedException('Missing state for Google sign-in');
    }

    const verifier = await this.verifiers.take(verifierKey(payload.state));
    if (!verifier) {
      // Expired, already used, or from an instance that has since restarted
      // without Redis. Retrying the sign-in mints a fresh one.
      throw new UnauthorizedException(
        'Google sign-in expired. Please try again.',
      );
    }

    const client = this.supabase.getOAuthClient({
      getItem: (key) => (key === OAUTH_VERIFIER_ITEM ? verifier : null),
      setItem: () => {},
      removeItem: () => {},
    });

    const { data, error } = await client.auth.exchangeCodeForSession(
      payload.code,
    );

    if (error) {
      this.logger.warn(`google callback failed: ${error.message}`);
      throw new UnauthenticatedException('Could not complete Google sign-in');
    }

    if (!data.user || !data.session) {
      throw new UnauthenticatedException('Could not complete Google sign-in');
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
      this.logger.warn(`refresh failed: ${error.message}`);
      throw new UnauthenticatedException(
        'Could not refresh session',
        'session_expired',
      );
    }

    if (!data.user || !data.session) {
      throw new UnauthenticatedException(
        'Could not refresh session',
        'session_expired',
      );
    }

    return {
      user: this.mapUser(data.user, this.providerOf(data.user)),
      session: this.mapSession(data.session),
    };
  }

  /**
   * Send a password-recovery email.
   *
   * Always reports success, even for an address with no account: the response
   * must not tell a stranger whether someone banks here.
   */
  async requestPasswordReset(
    payload: RequestPasswordResetDto,
  ): Promise<{ success: true }> {
    const email = payload.email.trim().toLowerCase();

    const { error } = await this.client().auth.resetPasswordForEmail(email, {
      redirectTo: payload.redirectTo,
    });

    // Rate limiting is the one failure worth surfacing — silence would look
    // like the mail was sent and leave the user waiting for nothing.
    if (error?.status === 429) {
      this.logger.warn(`password reset rate-limited: ${error.message}`);
      throw new CodedException(
        'rate_limited',
        'Too many reset requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return { success: true };
  }

  /**
   * Set a new password using the recovery link's access token.
   *
   * The token comes from the emailed link, so possession of it is the proof of
   * identity — there is no old password to check.
   */
  async updatePassword(payload: UpdatePasswordDto): Promise<AuthResult> {
    const { data, error } = await this.client().auth.getUser(
      payload.accessToken,
    );

    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired recovery link');
    }

    if (!this.supabase.hasAdminClient()) {
      throw new InternalServerErrorException(
        'Password reset is not configured',
      );
    }

    const { error: updateError } = await this.supabase
      .getAdminClient()
      .auth.admin.updateUserById(data.user.id, { password: payload.password });

    if (updateError) {
      throw new BadRequestException(updateError.message);
    }

    // Sign in straight away: the alternative is asking someone who has just
    // proved who they are to type the password they set one screen ago.
    return this.login({
      email: data.user.email ?? '',
      password: payload.password,
    });
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
