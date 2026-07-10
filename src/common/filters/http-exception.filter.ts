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

    const message =
      payload.message ??
      (exception instanceof Error ? exception.message : 'Internal server error');
    const error =
      payload.error ??
      (exception instanceof HttpException
        ? exception.name
        : 'Internal Server Error');

    const logLine = `${request.method} ${request.url} ${statusCode} - ${JSON.stringify(
      message,
    )}`;

    // 5xx are unexpected: log with stack. 4xx are client errors: log as warning.
    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
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
