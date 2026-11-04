/**
 * 生产构建本地预览：静态托管 dist + 代理 /api 与 /uploads 到后端 :3000。
 * 替代 npx serve（纯静态无代理，会导致 /uploads 音频 404 无声）。
 * 运行：node serve-dist.mjs（cwd = apps/web）
 * P2-12：对齐生产行为 —— 文本资源 gzip；内容哈希资源 immutable 长缓存
 */
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const DIST = fileURLToPath(new URL('./dist', import.meta.url));
const PORT = 5173;
const API = 'http://localhost:3000';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
};

// 可压缩的文本类型（二进制格式 png/mp3/woff2 自带压缩，不再 gzip）
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);

/**
 * 缓存策略：
 * - /assets/ 下为 Vite 内容哈希产物（含 pages/ 页面 chunk）—— immutable 长缓存
 * - index.html / sw.js / push-sw.js / manifest / 图标 —— no-cache，
 *   保证 SW 更新检查与新版本发布即时生效
 */
function cacheControl(rel) {
  if (rel.startsWith('assets/') || rel.startsWith('assets\\')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);

  // 代理 API 与音频上传目录到后端
  if (path.startsWith('/api/') || path.startsWith('/uploads/')) {
    const proxy = request(
      API + req.url,
      { method: req.method, headers: { ...req.headers, host: 'localhost:3000' } },
      (pr) => {
        res.writeHead(pr.statusCode ?? 502, pr.headers);
        pr.pipe(res);
      },
    );
    proxy.on('error', () => {
      res.writeHead(502);
      res.end('proxy error: backend down?');
    });
    req.pipe(proxy);
    return;
  }

  // 静态文件 + SPA fallback
  (async () => {
    const rel = normalize(path).replace(/^([/\\])+/, '');
    const ext = extname(rel);
    const acceptGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');

    const serve = async (file, relForCache) => {
      const data = await readFile(file);
      const headers = {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': cacheControl(relForCache),
      };
      if (acceptGzip && COMPRESSIBLE.has(extname(file)) && data.length > 1024) {
        send(res, 200, { ...headers, 'Content-Encoding': 'gzip' }, gzipSync(data));
      } else {
        send(res, 200, headers, data);
      }
    };

    try {
      await serve(join(DIST, rel || 'index.html'), rel || 'index.html');
    } catch {
      await serve(join(DIST, 'index.html'), 'index.html');
    }
  })();
}).listen(PORT, () => console.log(`dist on :${PORT}, proxy /api & /uploads → :3000`));
