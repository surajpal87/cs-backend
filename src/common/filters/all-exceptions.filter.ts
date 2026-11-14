import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { GameRuleError } from '../../games/core/engine';

/**
 * Uniform error envelope: { error: { code, message, details? }, requestId }.
 * Internal errors are logged with stack but never leaked to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as string | { message?: string | string[]; error?: string; code?: string };
      if (typeof body === 'string') message = body;
      else {
        if (Array.isArray(body.message)) {
          message = 'Validation failed';
          details = body.message;
        } else message = body.message ?? exception.message;
        code = body.code ?? HttpStatus[status] ?? code;
      }
      if (code === 'INTERNAL_ERROR') code = HttpStatus[status] ?? code;
    } else if (exception instanceof GameRuleError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      code = exception.code;
      message = exception.message;
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        code = 'CONFLICT';
        message = 'A record with these details already exists';
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        code = 'NOT_FOUND';
        message = 'Record not found';
      } else this.log.error(exception.message, exception.stack);
    } else {
      this.log.error(`${req.method} ${req.url} failed`, (exception as Error)?.stack ?? String(exception));
    }
    res.status(status).json({ error: { code, message, ...(details ? { details } : {}) }, requestId: req.id });
  }
}
