import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ErrorCode } from './error-code';

/**
 * These subclass the ordinary Nest exceptions rather than `HttpException`
 * directly, so `instanceof ForbiddenException` keeps holding for every existing
 * catch block and test. All they add is a `code` the client can branch on;
 * `message` stays a diagnostic for the log.
 *
 * See memory/error-handling.md.
 */
function body(code: ErrorCode, message: string) {
  return { message, code };
}

/** Base for a coded exception at an arbitrary status. */
export class CodedException extends HttpException {
  constructor(code: ErrorCode, message: string, status: HttpStatus) {
    super(body(code, message), status);
  }
}

export class UnauthenticatedException extends UnauthorizedException {
  constructor(message = 'Not authenticated', code: ErrorCode = 'unauthenticated') {
    super(body(code, message));
  }
}

export class NotHouseholdMemberException extends ForbiddenException {
  constructor(message = 'Not a member of this household') {
    super(body('not_household_member', message));
  }
}

export class NotHouseholdCreatorException extends ForbiddenException {
  constructor(message = 'Only the household creator may do this') {
    super(body('not_household_creator', message));
  }
}

/** A refusal the client offers a way out of — e.g. reassigning before delete. */
export class ConflictWithCodeException extends ConflictException {
  constructor(
    code: ErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super({ ...body(code, message), ...extra });
  }
}

export class UpstreamUnavailableException extends ServiceUnavailableException {
  constructor(message = 'Upstream provider is unavailable') {
    super(body('upstream_unavailable', message));
  }
}
