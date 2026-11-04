import { gzipSync } from 'node:zlib';
import type { NextFunction, Request, Response } from 'express';

/**
 * API 响应 gzip 压缩中间件（P2-13）
 *
 * 背景：Lighthouse 在 /stats 报「文本压缩审计未通过」——该页一次请求 7 个 JSON 接口，
 * 而 serve-dist 只压缩静态资源，代理到 API 的 JSON 是明文透传。
 *
 * 设计取舍：
 * - 仅压缩文本类响应（JSON/JS/XML/SVG/text），音频、图片、woff2 本身已压缩，跳过
 * - 小于 512B 的响应不压缩：gzip 头开销（约 20 字节）与收益基本抵消，
 *   且小响应压缩后反而可能变大；实测 1KB 的 JSON 可压至 1/3，512B 起压划算
 * - 仅挂在 /api 下：/uploads 的音频走 express 静态流式输出，不进入缓冲逻辑
 * - 用 Buffer 缓冲后一次性压缩：API 响应均为内存中小体量 JSON，无流式接口，
 *   缓冲不会造成内存压力（已确认 src 内无 res.write/StreamableFile 用法）
 */
const MIN_BYTES = 512;

/** 可压缩的 Content-Type 前缀（正则不区分大小写） */
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|xhtml\+xml|manifest\+json|ld\+json)|image\/svg\+xml)/i;

/** 是否可压缩 */
export function isCompressibleContentType(contentType: string): boolean {
  return COMPRESSIBLE.test(contentType.trim());
}

export function gzipMiddleware(req: Request, res: Response, next: NextFunction): void {
  const accept = String(req.headers['accept-encoding'] ?? '');
  // HEAD 无响应体；客户端不支持 gzip 时保持原样
  if (req.method === 'HEAD' || !/\bgzip\b/i.test(accept)) {
    next();
    return;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let endCallback: (() => void) | undefined;
  let finished = false;

  const target = res as unknown as {
    write: (...args: unknown[]) => boolean;
    end: (...args: unknown[]) => Response;
  };
  const originalEnd = target.end.bind(res) as (...args: unknown[]) => Response;

  const append = (chunk: unknown, encoding?: unknown): void => {
    if (chunk == null) return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
        : Buffer.from(chunk as Uint8Array);
    chunks.push(buf);
    total += buf.byteLength;
  };

  // 拦截写入：只缓冲，不落到 socket
  target.write = (chunk?: unknown, encoding?: unknown, cb?: unknown): boolean => {
    if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    append(chunk, encoding);
    // 写入已进入内存缓冲，回调可立即视为完成
    if (typeof cb === 'function') (cb as (err?: unknown) => void)(undefined);
    return true;
  };

  target.end = (chunk?: unknown, encoding?: unknown, cb?: unknown): Response => {
    if (typeof chunk === 'function') {
      cb = chunk;
      chunk = undefined;
    }
    if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    append(chunk, encoding);
    if (typeof cb === 'function') endCallback = cb as () => void;

    if (finished) return res;
    finished = true;

    const body = Buffer.concat(chunks, total);

    const compress =
      !res.headersSent &&
      total > 0 &&
      total >= MIN_BYTES &&
      !res.getHeader('content-encoding') &&
      res.statusCode !== 204 &&
      res.statusCode !== 304 &&
      isCompressibleContentType(String(res.getHeader('content-type') ?? ''));

    if (!compress) {
      // 原样输出（保持 express 原有的 Content-Length 语义）
      res.setHeader('Content-Length', String(total));
      return originalEnd(total ? body : undefined, endCallback);
    }

    try {
      const gz = gzipSync(body, { level: 6 });
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(gz.byteLength));
      // 让代理/浏览器缓存按编码区分，避免把 gzip 版本发给不支持 gzip 的客户端
      const vary = String(res.getHeader('Vary') ?? '');
      if (!/accept-encoding/i.test(vary)) {
        res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
      }
      return originalEnd(gz, endCallback);
    } catch {
      // 压缩失败时降级为明文，保证请求不因优化逻辑而中断
      res.removeHeader('Content-Encoding');
      res.setHeader('Content-Length', String(total));
      return originalEnd(body, endCallback);
    }
  };

  next();
}
