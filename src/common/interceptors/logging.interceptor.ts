import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';

interface LoggableRequest {
  method: string;
  originalUrl?: string;
  url: string;
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

interface LoggableResponse {
  statusCode: number;
}

/**
 * Logs every incoming request and its successful response. Errors are logged
 * by `HttpExceptionFilter`, so this interceptor only reports the success path
 * (the `error` branch below is a safety net if a request bypasses the filter).
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<LoggableRequest>();
    const response = http.getResponse<LoggableResponse>();

    const method = request.method;
    const url = request.originalUrl ?? request.url;
    const startedAt = Date.now();

    this.logger.log(
      `--> ${method} ${url} ${this.serialize({
        body: sanitize(request.body),
        query: request.query,
        params: request.params,
      })}`,
    );

    return next.handle().pipe(
      tap({
        next: (data) => {
          const ms = Date.now() - startedAt;
          this.logger.log(
            `<-- ${method} ${url} ${response.statusCode} ${ms}ms ${this.serialize(
              { response: sanitize(data) },
            )}`,
          );
        },
        error: (err: unknown) => {
          const ms = Date.now() - startedAt;
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`<-- ${method} ${url} FAILED ${ms}ms - ${message}`);
        },
      }),
    );
  }

  private serialize(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
}

const SENSITIVE_KEYS = new Set([
  'password',
  'newpassword',
  'oldpassword',
  'currentpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'refresh_token',
  'access_token',
  'authorization',
  'apikey',
  'api_key',
  'secret',
  'clientsecret',
  'client_secret',
]);

/**
 * Recursively redact sensitive fields so credentials never reach the logs.
 */
function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 6) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase())
        ? '[REDACTED]'
        : sanitize(val, depth + 1);
    }
    return out;
  }

  return value;
}
