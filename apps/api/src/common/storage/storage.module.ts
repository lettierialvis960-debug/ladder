import { Module, DynamicModule, Global, Logger, Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { StorageService } from './storage.interface';
import { LocalStorageService } from './local-storage.service';
import { ObjectStorageService } from './object-storage.service';
import { StorageUrlInterceptor } from './storage-url.interceptor';

/**
 * StorageModule — 根据 STORAGE_BACKEND env 切换实现
 *   STORAGE_BACKEND=local  (默认) → LocalStorageService
 *   STORAGE_BACKEND=s3           → ObjectStorageService (S3 兼容 API)
 *
 * 业务代码注入：constructor(private readonly storage: StorageService) {}
 */
@Global()
@Module({})
export class StorageModule {
  private static logger = new Logger('StorageModule');

  static forRoot(): DynamicModule {
    const backend = (process.env.STORAGE_BACKEND ?? 'local').toLowerCase();

    const provider: Provider = backend === 's3'
      ? { provide: StorageService, useClass: ObjectStorageService }
      : { provide: StorageService, useClass: LocalStorageService };

    if (backend === 's3') {
      this.logger.log('Storage backend → S3-compatible object storage');
    } else {
      this.logger.log('Storage backend → local filesystem (set STORAGE_BACKEND=s3 for production)');
    }

    if ((process.env.STORAGE_PRIVATE ?? 'false').toLowerCase() === 'true') {
      this.logger.log('Private bucket mode → audioUrl will be signed on response');
    }

    return {
      module: StorageModule,
      providers: [
        provider,
        // 全局拦截器：私有桶时把出站 audioUrl 换成限时预签名 URL
        { provide: APP_INTERCEPTOR, useClass: StorageUrlInterceptor },
      ],
      exports: [StorageService],
    };
  }
}
