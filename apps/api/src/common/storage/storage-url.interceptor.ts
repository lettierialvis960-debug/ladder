import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, of, firstValueFrom } from 'rxjs';
import { StorageService } from './storage.interface';

/**
 * 私有桶场景下，把响应里所有 audioUrl（以及嵌套字段）替换为限时预签名 URL。
 *
 * 设计原则：
 *  - 数据库里存的永远是 getPublicUrl() 的稳定地址（预签名 URL 会过期，绝不能落库）；
 *  - 只在出站响应这一层统一改写，业务 service 无需感知存储是否私有；
 *  - 仅处理 plain object / array，Date、Buffer、Decimal 等原样透传；
 *  - 非私有模式（本地 / 公共读 + CDN）直接透传，零开销。
 */
@Injectable()
export class StorageUrlInterceptor implements NestInterceptor {
  constructor(private readonly storage: StorageService) {}

  async intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const data = await firstValueFrom(next.handle());

    if (!this.storage.rewritesUrls || data === null || data === undefined) {
      return of(data);
    }

    const cache = new Map<string, string>();
    return of(await this.rewrite(data, cache));
  }

  private async rewrite(value: unknown, cache: Map<string, string>): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this.rewrite(item, cache)));
    }

    if (!isPlainObject(value)) {
      return value;
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key.endsWith('audioUrl') && typeof val === 'string') {
        out[key] = await this.resolve(val, cache);
      } else {
        out[key] = await this.rewrite(val, cache);
      }
    }
    return out;
  }

  private async resolve(url: string, cache: Map<string, string>): Promise<string> {
    const objectKey = this.storage.parseKeyFromUrl(url);
    if (!objectKey) return url; // 外部 URL（如第三方音频），原样保留

    const cached = cache.get(objectKey);
    if (cached) return cached;

    const signed = await this.storage.getDownloadUrl(objectKey);
    cache.set(objectKey, signed);
    return signed;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
