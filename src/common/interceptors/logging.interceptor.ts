import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';

interface PinoRequest {
  log?: { setBindings?: (bindings: Record<string, unknown>) => void };
  user?: { id?: string; sub?: string };
  route?: { path?: string };
}

/**
 * pino-http already logs one line per request/response with method, url, status
 * and duration, so this interceptor no longer logs anything itself — two
 * interceptor lines plus pino's own line was the same request written three
 * times, tripling Loki ingest for no extra information.
 *
 * What it still does is enrich pino's line with what only Nest knows: the
 * matched route pattern (so `/assets/:id` groups in Grafana instead of
 * splitting per id), the authenticated user, and the SHAPE of the response.
 * `setBindings` mutates the request-scoped child logger, so these fields land
 * on the single completion line pino emits when the response closes.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<PinoRequest>();
    const setBindings = request.log?.setBindings?.bind(request.log);

    if (!setBindings) return next.handle();

    setBindings({
      handler: `${context.getClass().name}.${context.getHandler().name}`,
      route: request.route?.path,
      userId: request.user?.id ?? request.user?.sub,
    });

    return next.handle().pipe(
      tap({
        next: (data) => setBindings({ payload: describe(data) }),
      }),
    );
  }
}

/**
 * Describe a response by SHAPE, not by content.
 *
 * A snapshots payload is up to 365 snapshots x their per-asset value lines.
 * Serializing that on every request costs event-loop time every other in-flight
 * request waits on, and stores megabytes in Loki nobody queries. Item count and
 * shape are what the log was actually useful for; the body belongs in a
 * debugger.
 */
function describe(data: unknown): string {
  if (data === null || data === undefined) return 'empty';
  if (Array.isArray(data)) return `array:${data.length}`;
  if (typeof data !== 'object') return typeof data;

  const record = data as Record<string, unknown>;
  if (Array.isArray(record.items)) {
    const total =
      typeof record.total === 'number' ? record.total : record.items.length;
    return `items:${record.items.length}/total:${total}`;
  }
  return `keys:${Object.keys(record).length}`;
}
