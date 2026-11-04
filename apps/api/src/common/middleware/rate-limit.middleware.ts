import { HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

/**
 * 基于 IP 的内存限流中间件（P2-4 登录限流）
 * - 进程内滑动窗口计数
 * - 5 分钟窗口内最多 10 次 login，5 次 register
 * - 每分钟清理过期桶
 */
interface Bucket {
  count: number;
  resetAt: number; // ms timestamp
}

const buckets = new Map<string, Bucket>();

// 每分钟清理过期桶
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (v.resetAt < now) buckets.delete(k);
  }
}, 60_000).unref();

/** 默认限流配置 */
export const DEFAULT_RATE_LIMIT = {
  windowMs: 5 * 60 * 1000, // 5 分钟
};

export function createRateLimitMiddleware(
  endpoint: string,
  max: number,
  windowSec: number = 300
) {
  const windowMs = windowSec * 1000;
  return (req: Request, res: Response, next: NextFunction) => {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      (req.headers['x-real-ip'] as string) ||
      req.ip ||
      req.socket.remoteAddress ||
      'unknown';
    const key = `${endpoint}:${ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 1, resetAt: now + windowMs };
      buckets.set(key, bucket);
    } else {
      bucket.count++;
    }

    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfterSec.toString());
      res.setHeader('X-RateLimit-Limit', max.toString());
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000).toString());
      throw new HttpException(
        {
          statusCode: 429,
          error: 'Too Many Requests',
          message: `请求过于频繁，请 ${retryAfterSec} 秒后再试`,
          retryAfter: retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    res.setHeader('X-RateLimit-Limit', max.toString());
    res.setHeader('X-RateLimit-Remaining', (max - bucket.count).toString());
    res.setHeader('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000).toString());
    next();
  };
}
