import { Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { BUILD_INFO } from './version';

/**
 * Process-level safety net for errors NestJS's per-request wrapper can't catch:
 * unhandled promise rejections (e.g. a forgotten `await` / fire-and-forget) and
 * synchronous errors thrown outside the request lifecycle (timers, background
 * tasks). We log the full error but deliberately DO NOT exit — the server keeps
 * serving. Errors inside a request are still handled by HttpExceptionFilter.
 */
function registerProcessGuards() {
  const logger = new Logger('Process');

  process.on('unhandledRejection', (reason) => {
    logger.error(
      'Unhandled promise rejection',
      reason instanceof Error ? reason.stack : String(reason),
    );
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error.stack ?? String(error));
  });
}

// Origins that work without any configuration: the Vite dev server and the
// deployed web app. `CORS_ORIGINS` replaces this list when set.
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'https://money-space-lac.vercel.app',
];

/**
 * Browser origins allowed to call the API, from `CORS_ORIGINS` (comma-separated),
 * falling back to `DEFAULT_CORS_ORIGINS`. The mobile app is not a browser and
 * sends no `Origin`, so it is never affected either way.
 */
function corsOrigins(): string[] {
  const configured = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    // A trailing slash never matches: the browser sends a bare scheme+host.
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return configured.length > 0 ? configured : DEFAULT_CORS_ORIGINS;
}

async function bootstrap() {
  registerProcessGuards();

  // `bufferLogs` holds bootstrap output until useLogger() swaps in Pino, so
  // even the startup lines come out as JSON instead of Nest's text format.
  // `rawBody` keeps the unparsed Buffer at `request.rawBody` for handlers that
  // need the exact bytes. Nest 11 STILL parses JSON alongside it, so no
  // existing route is affected — every controller keeps receiving a parsed
  // body. PayOS actually signs the `data` object rather than the raw bytes, so
  // its webhook does not need this; it is enabled because a gateway that signs
  // raw bytes is the norm, and finding this out after taking a payment is
  // worse than one flag now.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(PinoLogger));
  app.flushLogs();
  app.enableCors({
    origin: corsOrigins(),
    // The app authenticates with a bearer token, not cookies. Leaving
    // credentials off keeps a wildcard origin legal in dev and means a stolen
    // session cannot ride along on a cross-site request.
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // The export download reads the filename off this header; cross-origin it
    // is invisible to JS unless named here. See export.controller.ts.
    exposedHeaders: ['Content-Disposition'],
  });

  // Every route is served under `/api/v1/*`. The prefix and the version live
  // here rather than in each @Controller so a future v2 is a per-route
  // `@Version('2')` opt-in instead of an edit across every controller.
  // `/` and `/health` stay unprefixed — uptime checks and the Caddy healthcheck
  // target them directly and must not move with the API version.
  app.setGlobalPrefix('api', { exclude: ['', 'health'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Without this, Nest never calls onModuleDestroy / onApplicationShutdown.
  // PrismaService has implemented the former since day one and was never run,
  // so every deploy dropped pooled connections uncleanly; analytics needs it to
  // flush its last batch. See memory/infrastructure/deployment.md.
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  // Names the build in the shipped logs, so a silent rollback is visible.
  new Logger('Bootstrap').log(
    `money-space-backend ${BUILD_INFO.version} (${BUILD_INFO.commit}) listening on ${port}`,
  );
}
bootstrap();
