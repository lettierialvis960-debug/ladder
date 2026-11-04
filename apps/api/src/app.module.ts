import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { ContentModule } from './modules/content/content.module';
import { PlansModule } from './modules/plans/plans.module';
import { LearningModule } from './modules/learning/learning.module';
import { StatsModule } from './modules/stats/stats.module';
import { PushModule } from './modules/push/push.module';
import { DialogueModule } from './modules/dialogue/dialogue.module';
import { QuizModule } from './modules/quiz/quiz.module';
import { StorageModule } from './common/storage/storage.module';
import { createRateLimitMiddleware } from './common/middleware/rate-limit.middleware';

@Module({
  imports: [
    StorageModule.forRoot(), // global；所有模块可注入 StorageService
    PrismaModule, AuthModule, ContentModule, PlansModule,
    LearningModule, StatsModule, PushModule, DialogueModule, QuizModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // P2-4 登录限流：Middleware 在 Controller 之前拦截，比 Guard 更可靠
    // 注意：MiddlewareConsumer.forRoutes 的 path 不带全局前缀 /api
    consumer
      .apply(
        createRateLimitMiddleware('login', 10, 300),  // 5 分钟 10 次
      )
      .forRoutes({ path: 'auth/login', method: 1 });
    consumer
      .apply(
        createRateLimitMiddleware('register', 5, 300), // 5 分钟 5 次
      )
      .forRoutes({ path: 'auth/register', method: 1 });
  }
}
