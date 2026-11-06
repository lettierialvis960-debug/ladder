import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { chunkFileNames } from './build/page-chunk';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // manifest 直接写在 index.html 里 + package.json build 脚本里手工 cp，
      // 不让 vite-plugin-pwa 生成（它会简化 icons 数组导致 PNG 图标丢失）
      manifest: false,
      workbox: {
        // P2-11：预缓存只留壳层（入口/vendor/共享 chunk/CSS/图标/manifest）。
        // 页面级懒加载 chunk 产物在 assets/pages/（见 chunkFileNames），
        // 不进入预缓存，SW 安装流量从 355.8KiB 降到壳层量级，页面保持按需加载。
        globPatterns: [
          'index.html',
          'manifest.webmanifest',
          'icon.svg',
          'icon-*.png',
          'push-sw.js',
          'assets/*.{js,css}',
        ],
        // 音频走运行时缓存，支持离线回听已缓存材料（P1 离线下载的前置）
        runtimeCaching: [
          {
            // 私有桶下发的是预签名 URL（带 ?X-Amz-* 查询串），因此不锚定结尾并忽略 query
            // ignoreSearch 让不同签名窗口共用同一缓存条目，避免缓存膨胀与离线失效
            urlPattern: /\/uploads\/.*\.(mp3|m4a|ogg|wav)(\?.*)?$/i,
            handler: 'CacheFirst',
            options: { cacheName: 'audio-files', matchOptions: { ignoreSearch: true } },
          },
          // P2-11：页面 chunk 内容哈希、不可变，CacheFirst 安全；
          // 访问过的路由离线可回退，未访问的由离线页「预热」后同样可离线（见 warmRouteChunks）
          {
            urlPattern: /\/assets\/pages\/.*\.(js|css)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'page-chunks',
              expiration: { maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          // P2-15：所有 GET 类 API 走 NetworkFirst，离线回退最近一次成功响应。
          // 覆盖 stats/learning/content/plans/push/dialogue 等只读接口，离线时页面能展示旧数据而非报错。
          // 排除：非确定性 GET（quiz/generate 每次生成新题）、大文件导出（stats/export*）。
          // 写操作（POST/PUT/DELETE/PATCH）通过 method: 'GET' 自动排除，不缓存。
          // 注意：生产构建 API 基地址为 http://localhost:3000/api（与 SW 所在 127.0.0.1:5173 跨域）。
          // workbox 的 RegExpRoute 对跨域请求要求正则从 URL 首字符开始匹配（result.index === 0），
          // 因此正则需锚定 scheme://host，不能只写 /\/api\/…/。
          {
            urlPattern: /^https?:\/\/[^/]+\/api\/(?!quiz\/generate|stats\/export)/,
            method: 'GET',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-data',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 120, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        // SPA 路由：离线时 fallback 到 index.html（React Router 接管）
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//],
        // 立即接管首次访问的页面：整包下载时预热的 chunk 才会真正进入 SW 缓存，
        // 否则首次会话（尚未被 SW 控制）下载后断网仍打不开未访问的页面
        clientsClaim: true,
        skipWaiting: true,
        // 注入推送事件处理（P1 提醒推送）：push / notificationclick
        importScripts: ['/push-sw.js'],
      },
      // dev 模式也启用 SW，便于本地端到端验证推送（dev-dist）
      devOptions: { enabled: true },
    }),
  ],
  build: {
    // 产出 .vite/manifest.json：整包下载时据此预热各页面 chunk，使未访问过的路由离线也能打开
    manifest: true,
    rollupOptions: {
      output: {
        // P2-10：框架代码独立成 vendor chunk，业务代码变更不会让用户重复下载 React
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-dom/client', 'react-router-dom'],
        },
        // P2-11：页面级懒加载 chunk 输出到 assets/pages/，
        // 与壳层 chunk 目录隔离，使 workbox.globPatterns 能把它们排除出预缓存
        chunkFileNames,
      },
    },
  },
  resolve: {
    // shared 包为 CJS 产物（供 NestJS 使用），其 `export *` 经 Rollup 无法静态解析命名导出；
    // web 构建直接消费其 TS 源码，绕开 CJS 互操作问题（dev 与 build 行为一致）。
    alias: {
      '@ladder/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
    },
  },
});
