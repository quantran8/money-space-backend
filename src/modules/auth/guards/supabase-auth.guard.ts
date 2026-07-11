import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from '../auth.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthUser } from '../entities/auth-user.entity';

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // The auth middleware already resolved `req.user` from the token; re-verify
    // here only if it didn't (e.g. token arrived after middleware, or absent).
    if (!request.user) {
      const token = extractBearerToken(request);
      if (!token) {
        throw new UnauthorizedException('Missing bearer token');
      }
      request.user = await this.authService.getUserFromToken(token);
    }
    return true;
  }
}

export function extractBearerToken(
  request: AuthenticatedRequest,
): string | null {
  const header = request.headers?.authorization;
  const value = Array.isArray(header) ? header[0] : header;

  if (!value) {
    return null;
  }

  const [scheme, token] = value.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token.trim();
}
