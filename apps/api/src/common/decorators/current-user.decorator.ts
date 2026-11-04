import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** 取当前登录用户 id（配合 JwtAuthGuard 使用） */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest();
  return req.user?.sub;
});
