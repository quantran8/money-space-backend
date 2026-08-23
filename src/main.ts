import { Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

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

async function bootstrap() {
  registerProcessGuards();

  const app = await NestFactory.create(AppModule);
  app.enableCors();

  // Every route is served under `/api/v1/*`. The prefix and the version live
  // here rather than in each @Controller so a future v2 is a per-route
  // `@Version('2')` opt-in instead of an edit across every controller.
  // `/` and `/health` stay unprefixed — uptime checks and the Caddy healthcheck
  // target them directly and must not move with the API version.
  app.setGlobalPrefix('api', { exclude: ['', 'health'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
