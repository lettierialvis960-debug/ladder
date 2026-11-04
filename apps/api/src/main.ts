import 'reflect-metadata';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { gzipMiddleware } from './common/middleware/gzip.middleware';

// 本地开发 / 裸机部署从 .env 载入；容器化环境直接使用系统环境变量（无 .env 时跳过）
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.setGlobalPrefix('api'); // 统一 /api 前缀
  // P2-13：API 响应 gzip（Node 内置 zlib，无新增依赖）；
  // 只挂 /api，/uploads 音频走静态流式输出不经过缓冲
  app.use('/api', gzipMiddleware);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors(); // 开发期放开，供 Vite(5173) 直连；生产按域名收敛

  // 本地存储模式：暴露 uploads/ 静态目录；S3 模式走对象存储绝对 URL，无需此目录
  if ((process.env.STORAGE_BACKEND ?? 'local').toLowerCase() !== 's3') {
    const uploadRoot = process.env.STORAGE_LOCAL_ROOT
      ?? join(process.cwd(), 'uploads');
    app.useStaticAssets(uploadRoot, { prefix: '/uploads/' });
  }

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
