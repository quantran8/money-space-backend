import { Injectable, NestMiddleware } from '@nestjs/common';
import { AuthService } from '../auth.service';
import {
  extractBearerToken,
  type AuthenticatedRequest,
} from '../guards/supabase-auth.guard';

/**
 * Populates `req.user` when a valid Supabase bearer token is present.
 *
 * This middleware is intentionally non-blocking: it never rejects a request.
 * Public routes (signup, login, google) keep working without a token, while
 * protected routes rely on {@link SupabaseAuthGuard} to enforce authentication.
 * Downstream handlers can read the authenticated user via the `@CurrentUser()`
 * decorator regardless of whether the guard is applied.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(private readonly authService: AuthService) {}

  async use(
    req: AuthenticatedRequest,
    _res: unknown,
    next: (error?: unknown) => void,
  ): Promise<void> {
    const token = extractBearerToken(req);

    if (token) {
      try {
        req.user = await this.authService.getUserFromToken(token);
      } catch {
        // Invalid/expired token: leave req.user undefined and let guards on
        // protected routes reject the request with a proper 401.
        req.user = undefined;
      }
    }

    next();
  }
}
