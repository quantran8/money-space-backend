import pino from 'pino';
import { buildLoggerParams } from './logger.config';

/**
 * Redaction and route silencing are the two things here that fail silently: a
 * broken redact path leaks a bearer token into a third-party log store, and a
 * broken ignore rule quietly triples ingest. Both are asserted below.
 */
describe('buildLoggerParams', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    delete process.env.LOG_LEVEL;
  });

  /** Puts a value through the log formatter, as pino would before serializing. */
  function censorRoundTrip(value: object): unknown {
    const { formatters } = buildLoggerParams().pinoHttp as {
      formatters: {
        log: (r: Record<string, unknown>) => Record<string, unknown>;
      };
    };
    return formatters.log({ v: value }).v;
  }

  /** Runs one record through a real pino instance built from our options. */
  function logOnce(record: Record<string, unknown>): Record<string, unknown> {
    const { transport: _transport, ...options } = buildLoggerParams()
      .pinoHttp as Record<string, unknown>;
    let written = '';
    const logger = pino(options, {
      write: (line: string) => {
        written = line;
      },
    });
    logger.info(record, 'test');
    return JSON.parse(written) as Record<string, unknown>;
  }

  describe('in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('emits JSON on stdout rather than routing through pino-pretty', () => {
      expect(buildLoggerParams().pinoHttp).toMatchObject({
        transport: undefined,
        level: 'info',
      });
    });

    it('redacts the authorization header', () => {
      const out = logOnce({
        req: { headers: { authorization: 'Bearer secret-token' } },
      });
      expect(JSON.stringify(out)).not.toContain('secret-token');
    });

    it('keeps every header but user-agent out of a real request', () => {
      // censor() hands live req/res objects on untouched (rebuilding them
      // would drop prototype accessors like res.statusCode), so the request
      // serializer is the ONLY thing standing between a bearer token and the
      // log. It projects a fixed field list rather than filtering a blocklist,
      // so a header added upstream cannot leak by default.
      const { serializers } = buildLoggerParams().pinoHttp as {
        serializers: { req: (r: unknown) => Record<string, unknown> };
      };
      const serialized = serializers.req({
        id: 'r1',
        method: 'GET',
        url: '/api/v1/households',
        headers: {
          authorization: 'Bearer secret-token',
          cookie: 'session=secret-cookie',
          'x-api-key': 'secret-key',
          'user-agent': 'curl/8.7.1',
        },
      });
      expect(Object.keys(serialized).sort()).toEqual([
        'id',
        'method',
        'url',
        'userAgent',
      ]);
      expect(JSON.stringify(serialized)).not.toMatch(
        /secret-token|secret-cookie|secret-key/,
      );
    });

    it('reads statusCode off a response that carries it on the prototype', () => {
      // Regression guard: censor() used to rebuild every object from
      // Object.entries(), which turned a live ServerResponse into {} and made
      // every logged status null.
      const { serializers } = buildLoggerParams().pinoHttp as {
        serializers: { res: (r: unknown) => Record<string, unknown> };
      };
      const res = Object.create({ statusCode: 401 }) as object;
      expect(serializers.res(censorRoundTrip(res))).toEqual({
        statusCode: 401,
      });
    });

    it('redacts credential-shaped fields at any depth', () => {
      const out = logOnce({
        req: { body: { password: 'hunter2' } },
        nested: { deeper: { token: 'abc123' } },
      });
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('abc123');
    });

    it('redacts a credential nested deeper than one wildcard level', () => {
      // The exact case pino's own `redact: ['*.token']` misses, which is why
      // censor() exists at all.
      const out = logOnce({
        upstream: { response: { body: { data: { token: 'deep-secret' } } } },
      });
      expect(JSON.stringify(out)).not.toContain('deep-secret');
    });

    it('redacts inside arrays', () => {
      const out = logOnce({ users: [{ name: 'a', password: 'leaky' }] });
      expect(JSON.stringify(out)).not.toContain('leaky');
    });

    it('survives a circular structure without hanging', () => {
      const cyclic: Record<string, unknown> = { name: 'req' };
      cyclic.self = cyclic;
      expect(() => logOnce({ cyclic })).not.toThrow();
    });

    it('keeps non-sensitive values intact', () => {
      const out = logOnce({ householdId: 'hh-1', nested: { count: 42 } });
      expect(out).toMatchObject({
        householdId: 'hh-1',
        nested: { count: 42 },
      });
    });

    it('preserves an Error rather than flattening it to an empty object', () => {
      const out = logOnce({ err: new Error('boom') });
      expect(JSON.stringify(out)).toContain('boom');
    });

    it('names the level instead of emitting pino numeric codes', () => {
      expect(logOnce({}).level).toBe('info');
    });

    it('stamps an ISO timestamp Loki can parse', () => {
      expect(logOnce({}).time).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    });

    it('labels every line with the service and env', () => {
      expect(logOnce({})).toMatchObject({
        service: 'money-space-backend',
        env: 'production',
      });
    });
  });

  it('defaults to debug + pino-pretty outside production', () => {
    process.env.NODE_ENV = 'development';
    const { pinoHttp } = buildLoggerParams() as {
      pinoHttp: Record<string, unknown>;
    };
    expect(pinoHttp.level).toBe('debug');
    expect(pinoHttp.transport).toMatchObject({ target: 'pino-pretty' });
  });

  it('honours an explicit LOG_LEVEL over the per-env default', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'warn';
    expect((buildLoggerParams().pinoHttp as { level: string }).level).toBe(
      'warn',
    );
  });

  describe('autoLogging.ignore', () => {
    const ignore = () => {
      const { autoLogging } = buildLoggerParams().pinoHttp as {
        autoLogging: { ignore: (req: { url: string }) => boolean };
      };
      return autoLogging.ignore;
    };

    it.each(['/health', '/', '/health?probe=1'])(
      'skips the uptime probe %s',
      (url) => {
        expect(ignore()({ url })).toBe(true);
      },
    );

    it.each(['/api/v1/households', '/api/v1/households?limit=10'])(
      'logs the real request %s',
      (url) => {
        expect(ignore()({ url })).toBe(false);
      },
    );
  });

  describe('customLogLevel', () => {
    const level = (statusCode: number, err?: Error) => {
      const { customLogLevel } = buildLoggerParams().pinoHttp as {
        customLogLevel: (
          req: unknown,
          res: { statusCode: number },
          err?: Error,
        ) => string;
      };
      return customLogLevel({}, { statusCode }, err);
    };

    // A 4xx is the caller's mistake, not an incident — keeping it out of the
    // error stream is what makes alerting on level="error" meaningful.
    it('reports a client error as a warning', () => {
      expect(level(404)).toBe('warn');
      expect(level(401)).toBe('warn');
    });

    it('reports a server error as an error', () => {
      expect(level(500)).toBe('error');
      expect(level(200, new Error('boom'))).toBe('error');
    });

    it('reports success as info', () => {
      expect(level(200)).toBe('info');
      expect(level(304)).toBe('info');
    });
  });

  it('mounts the request logger on every route', () => {
    // nestjs-pino's own default is the object form `{ path: '*', method: ALL }`,
    // which Nest 11 drops silently here — the middleware never mounts and not a
    // single request line is logged. Regression guard for exactly that.
    expect(buildLoggerParams().forRoutes).toEqual(['*']);
  });
});
