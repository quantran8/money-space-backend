import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import { RAW_RESPONSE } from './raw-response.decorator';

export interface ApiResponse<T> {
  success: true;
  statusCode: number;
  message: string;
  data: T;
  timestamp: string;
  path: string;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T> | T
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T> | T> {
    // A handler whose response shape belongs to someone else — see
    // `RawResponse`. Checked first so nothing else runs for it.
    const raw = this.reflector.getAllAndOverride<boolean | undefined>(
      RAW_RESPONSE,
      [context.getHandler(), context.getClass()],
    );
    if (raw) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<{ url: string }>();
    const response = http.getResponse<{ statusCode: number }>();

    return next.handle().pipe(
      map((data) => ({
        success: true,
        statusCode: response.statusCode,
        message: 'OK',
        data,
        timestamp: new Date().toISOString(),
        path: request.url,
      })),
    );
  }
}
