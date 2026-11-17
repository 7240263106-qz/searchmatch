import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { isErrorCode, messageOf, httpStatusOf } from '@competition/contracts';

interface ExceptionBody {
  code?: string;
  message?: string;
  details?: unknown;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const traceId = String(Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const body: ExceptionBody =
        typeof raw === 'string' ? { message: raw } : (raw as ExceptionBody);
      const code =
        body.code && isErrorCode(body.code)
          ? body.code
          : status === HttpStatus.NOT_FOUND
            ? 'RESOURCE_NOT_FOUND'
            : status === HttpStatus.FORBIDDEN
              ? 'AUTH_FORBIDDEN'
              : status === HttpStatus.UNAUTHORIZED
                ? 'AUTH_UNAUTHORIZED'
                : 'VALIDATION_FAILED';
      response.status(status).json({
        error: {
          code,
          message: body.message ?? messageOf(code),
          details: body.details ?? null,
          traceId,
        },
      });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    response.status(httpStatusOf('INTERNAL_ERROR')).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: messageOf('INTERNAL_ERROR'),
        traceId,
      },
    });
  }
}