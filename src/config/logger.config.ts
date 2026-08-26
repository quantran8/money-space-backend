import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';

/**
 * Key names whose value never reaches a log line, compared lowercased.
 *
 * Applied by `censor()` below rather than by pino's own `redact` option: a
 * redact path is literal, and its `*` wildcard matches exactly ONE level. So
 * `*.token` covers `{ a: { token } }` and silently misses
 * `{ a: { b: { token } } }` — which is the shape a nested DTO or an upstream
 * error payload actually arrives in. Anything short of a recursive walk leaks.
 */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'password',
  'newpassword',
  'oldpassword',
  'currentpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'refresh_token',
  'access_token',
  'apikey',
  'api_key',
  'secret',
  'clientsecret',
  'client_secret',
]);

const CENSOR = '[REDACTED]';

/**
 * Depth cap. A cycle is already handled by the `seen` set, but a legitimately
 * deep structure would still cost a full walk on every line; past this depth
 * the value is summarised rather than descended into.
 */
const MAX_DEPTH = 8;

/**
 * Recursively replace the value of any sensitive key, at any depth.
 *
 * Runs on every emitted record, so it must not throw and must not hang: the
 * `seen` set breaks cycles (an Express req/res pair is circular), and anything
 * that is not a plain object or array is returned untouched.
 */
function censor(value: unknown, depth = 0, seen = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth > MAX_DEPTH) return '[Truncated]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => censor(item, depth + 1, seen));
  }

  // Only PLAIN objects are rebuilt. `formatters.log` runs BEFORE the
  // serializers, so `req`/`res` arrive here as live IncomingMessage /
  // ServerResponse instances — rebuilding those from Object.entries() drops
  // every accessor that lives on the prototype, and `res.statusCode` silently
  // becomes null in the output. Errors, Buffers and Dates are equally not ours
  // to rebuild. All of them are handed on untouched; the credentials they
  // carry (`req.headers.authorization`) are censored by the serializers, which
  // only ever project the handful of fields listed there.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase())
      ? CENSOR
      : censor(val, depth + 1, seen);
  }
  return out;
}

/**
 * Routes excluded from per-request logging. /health is polled by the compose
 * healthcheck every 30s and by the uptime monitor — logging it fills Loki with
 * lines nobody reads and inflates the ingest volume the free tier is capped on.
 */
const SILENT_ROUTES = ['/health', '/'];

/**
 * Pino sits behind Nest's own Logger interface (nestjs-pino), so every existing
 * `new Logger(...)` call keeps working and now emits JSON instead of Nest's
 * coloured text. Alloy tails that JSON off the container's stdout, so the app
 * writes to stdout only — no file appender, no log rotation to own.
 *
 * In dev the output goes through pino-pretty instead: a JSON line per request
 * is unreadable in a terminal, and nothing is scraping a laptop.
 */
export function buildLoggerParams(): Params {
  const isProduction = process.env.NODE_ENV === 'production';
  const level = process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug');

  return {
    // Same spelling AuthMiddleware already uses. nestjs-pino's default is
    // `{ path: '*', method: ALL }`, an object form Nest 11 drops silently here
    // — the middleware never mounts and not one request line is logged.
    forRoutes: ['*'],
    pinoHttp: {
      level,
      // Loki indexes by label, not by content: these become the stream labels
      // Alloy forwards, so `{service="money-space-backend", env="production"}`
      // selects this app's logs without a full-text scan.
      base: {
        service: process.env.SERVICE_NAME ?? 'money-space-backend',
        env: process.env.NODE_ENV ?? 'development',
      },

      // Loki wants an ISO timestamp it can parse; pino's default is epoch ms.
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      // `level: 30` is meaningless in a Grafana filter — emit the name.
      formatters: {
        level: (label) => ({ level: label }),
        // The redaction pass. `log` sees the whole record, which is what makes
        // the walk depth-independent — see SENSITIVE_KEYS.
        log: (record) => censor(record) as Record<string, unknown>,
      },

      // Correlates every line of one request, including the ones logged from
      // deep inside a service, because nestjs-pino puts this id on the
      // request-scoped child logger.
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const existing = req.headers['x-request-id'];
        const id =
          (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },

      // A 4xx is the client's fault, not an incident — keep it out of the error
      // stream so alerting on `level="error"` stays meaningful.
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },

      // The default serializers dump every header and the whole body. Both are
      // large and mostly noise; the fields below are what a query actually
      // filters on.
      // `headers` is optional here even though pino-http always supplies it:
      // any hand-written `logger.info({ req })` would otherwise throw inside
      // the serializer and lose the line entirely.
      serializers: {
        req: (
          req: Partial<IncomingMessage> & { id?: string; url?: string },
        ) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          userAgent: req.headers?.['user-agent'],
        }),
        res: (res: Partial<ServerResponse>) => ({
          statusCode: res.statusCode,
        }),
      },

      autoLogging: {
        ignore: (req: IncomingMessage) =>
          SILENT_ROUTES.includes((req.url ?? '').split('?')[0]),
      },

      transport: isProduction
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              singleLine: true,
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname,service,env',
            },
          },
    },
  };
}
