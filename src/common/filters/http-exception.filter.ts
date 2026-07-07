import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
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
  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<{
      status: (statusCode: number) => { json: (body: ErrorBody) => void };
    }>();
    const request = http.getRequest<{ url: string }>();

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
