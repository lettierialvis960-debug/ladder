import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

/**
 * 全局异常过滤器：把 Prisma/运行时异常翻译成有意义的 HTTP 响应，
 * 避免 NestJS 默认把所有未捕获异常变成 500 + "Internal server error" 让前端无从排查。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = '服务器开小差了';
    let errorName = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      // NestJS 内置 HttpException 的 getResponse() 可能是字符串或对象
      message = typeof res === 'string' ? res : (res as { message?: string })?.message ?? exception.message;
      errorName = exception.constructor.name.replace('Exception', '') || 'Http';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Prisma 已知错误码映射
      switch (exception.code) {
        case 'P2002':
          status = HttpStatus.CONFLICT;
          message = '数据已存在（唯一约束冲突）';
          errorName = 'Conflict';
          break;
        case 'P2025':
          status = HttpStatus.NOT_FOUND;
          message = exception.message.includes('no rows') ? '数据不存在' : exception.message;
          errorName = 'NotFound';
          break;
        case 'P2003':
          status = HttpStatus.BAD_REQUEST;
          message = '关联数据不存在，无法保存';
          errorName = 'ForeignKey';
          break;
        case 'P2000':
          status = HttpStatus.BAD_REQUEST;
          message = '数据字段超长或非法';
          errorName = 'Validation';
          break;
        default:
          status = HttpStatus.BAD_REQUEST;
          message = `数据操作失败 (${exception.code})`;
          errorName = 'Prisma';
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      message = '数据库查询参数不合法';
      errorName = 'Validation';
    } else if (exception instanceof Prisma.PrismaClientRustPanicError) {
      this.logger.error(`Prisma panic on ${request.method} ${request.url}`, exception.message);
      message = '数据库异常，请稍后重试';
    } else if (exception instanceof Prisma.PrismaClientInitializationError) {
      this.logger.error(`DB initialization error`, exception.message);
      message = '数据库未连接，请稍后重试';
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled on ${request.method} ${request.url}: ${exception.message}`, exception.stack ?? '');
      message = exception.message;
    } else {
      this.logger.error(`Unknown exception on ${request.method} ${request.url}`, String(exception));
    }

    // 401/403/404/409/500 等关键码日志级别提升
    if (status >= 500) {
      this.logger.error(`${status} ${request.method} ${request.url} — ${errorName}: ${message}`);
    } else if (status >= 400 && status !== 401) {
      this.logger.warn(`${status} ${request.method} ${request.url} — ${errorName}: ${message}`);
    }

    response.status(status).json({
      statusCode: status,
      error: errorName,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
