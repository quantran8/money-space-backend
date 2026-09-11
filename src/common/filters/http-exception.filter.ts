import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';

/**
 * A raw URL carries the householdId and every other path id. Replacing them
 * keeps one fault as one group rather than one per household — the same reason
 * `LoggingInterceptor` prefers `request.route.path`. Used only when Express
 * did not resolve a route pattern (an unmatched path, a 404).
 */
function scrubUrl(url: string): string {
  return url
    .split('?')[0]
    .replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '/:id',
    )
    .replace(/\/\d+/g, '/:id');
}

interface ErrorBody {
  success: false;
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
  /**
   * The machine-readable reason, when a throw site names one. The client picks
   * its copy from this — `message` is a diagnostic and is never displayed.
   * See memory/error-handling.md.
   */
  code?: string;
  /**
   * Only on a 402 from `PremiumRequiredException`: which limit was hit, and
   * what the current plan allows. Forwarded because the client cannot pick the
   * right paywall from a status code alone, and parsing `message` for it would
   * make a copy string load-bearing.
   */
  premium?: Record<string, unknown>;
  /** Only on a 409 from `TrialUnavailableException`: why the trial is not on offer. */
  trial?: Record<string, unknown>;
  /** Only on `asset_in_use`: what still links to the asset, so the client can offer a cascade. */
  impact?: Record<string, unknown>;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly analytics: AnalyticsService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<{
      status: (statusCode: number) => { json: (body: ErrorBody) => void };
    }>();
    const request = http.getRequest<{
      url: string;
      method: string;
      route?: { path?: string };
      membership?: { householdId?: string };
    }>();

    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const payload =
      typeof exceptionResponse === 'object' && exceptionResponse !== null
        ? (exceptionResponse as Record<string, unknown>)
        : {};

    // Unexpected 5xx (non-HttpException — e.g. a raw Prisma/DB error) must never
    // leak internal details to the client in production. In dev we surface the
    // real message to make debugging easier; on prod we return a generic one.
    // The full message + stack are always written to the server log below.
    const isServerError = statusCode >= HttpStatus.INTERNAL_SERVER_ERROR;
    // Allow-list, not `!== 'production'`: an unset or misspelled NODE_ENV on a
    // deployed box must fail closed, not start echoing Prisma at the client.
    const env = process.env.NODE_ENV;
    const isLocal = env === 'development' || env === 'test';

    const rawMessage =
      payload.message ??
      (exception instanceof Error
        ? exception.message
        : 'Internal server error');
    const message =
      isServerError && !isLocal ? 'Internal server error' : rawMessage;
    const error =
      payload.error ??
      (exception instanceof HttpException
        ? exception.name
        : 'Internal Server Error');

    // Log the raw message (not the client-sanitized one) so prod logs keep the
    // real cause even when the client only sees "Internal server error".
    const logLine = `${request.method} ${request.url} ${statusCode} - ${JSON.stringify(
      rawMessage,
    )}`;

    // 5xx are unexpected: log with stack. 4xx are client errors: log as warning.
    if (isServerError) {
      this.logger.error(
        logLine,
        exception instanceof Error ? exception.stack : undefined,
      );

      // 5xx ONLY. A 402 is the paywall working and a 403 is a non-member —
      // routing those here would bury real faults under the app behaving.
      //
      // The route PATTERN, never `request.url`: the raw path carries the
      // householdId, which would both explode cardinality and put an
      // identifier in an error title. No body, no query — they carry money.
      this.analytics.captureException(exception, {
        householdId: request.membership?.householdId,
        route: request.route?.path ?? scrubUrl(request.url),
        statusCode,
      });
    } else {
      this.logger.warn(logLine);
    }

    response.status(statusCode).json({
      success: false,
      statusCode,
      message: message as string | string[],
      error: String(error),
      timestamp: new Date().toISOString(),
      path: request.url,
      ...(typeof payload.code === 'string' ? { code: payload.code } : {}),
      ...(payload.premium
        ? { premium: payload.premium as Record<string, unknown> }
        : {}),
      ...(payload.trial
        ? { trial: payload.trial as Record<string, unknown> }
        : {}),
      ...(payload.impact
        ? { impact: payload.impact as Record<string, unknown> }
        : {}),
    });
  }
}
