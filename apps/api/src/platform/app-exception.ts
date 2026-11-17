import { HttpException } from '@nestjs/common';
import { httpStatusOf, messageOf } from '@competition/contracts';

export class AppException extends HttpException {
  readonly code: string;

  constructor(code: string, details?: unknown, message?: string) {
    super({ code, message: message ?? messageOf(code), details }, httpStatusOf(code));
    this.code = code;
  }
}