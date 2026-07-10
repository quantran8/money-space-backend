import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

interface ErrorBody {
  success: false;
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<{
      status: (statusCode: number) => { json: (body: ErrorBody) => void };
    }>();
    const request = http.getRequest<{ url: string; method: string }>();

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
    const isProduction = process.env.NODE_ENV === 'production';

    const rawMessage =
      payload.message ??
      (exception instanceof Error
        ? exception.message
        : 'Internal server error');
    const message =
      isServerError && isProduction ? 'Internal server error' : rawMessage;
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
    });
  }
}
