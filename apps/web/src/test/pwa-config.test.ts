import { describe, it, expect } from 'vitest';
import {
  chunkFileNames,
  PAGE_CHUNK_FILE_NAMES,
  SHELL_CHUNK_FILE_NAMES,
} from '../../build/page-chunk';
import configSource from '../../vite.config.ts?raw';

/**
 * P2-11：PWA 预缓存策略
 * 壳层（入口/vendor/共享 chunk/CSS）保持预缓存，页面懒加载 chunk 剥离到
 * assets/pages/ 走运行时 CacheFirst —— SW 安装不再后台拉取全部页面代码，
 * 同时已访问路由离线可回退。
 */
describe('PWA 预缓存策略（P2-11）', () => {
  it('chunkFileNames 把页面懒加载 chunk 路由到 assets/pages/，壳层 chunk 留在 assets/', () => {
    // posix 与 Windows 路径分隔符都要识别
    expect(chunkFileNames({ facadeModuleId: '/repo/apps/web/src/pages/Stats/index.tsx' })).toBe(
      PAGE_CHUNK_FILE_NAMES,
    );
    expect(
      chunkFileNames({ facadeModuleId: 'E:\\dev\\ladder\\apps\\web\\src\\pages\\Stats\\index.tsx' }),
    ).toBe(PAGE_CHUNK_FILE_NAMES);

    // 共享 chunk（无 facade）与入口路径模块留在壳层目录
    expect(chunkFileNames({ facadeModuleId: null })).toBe(SHELL_CHUNK_FILE_NAMES);
    expect(chunkFileNames({ facadeModuleId: '/repo/apps/web/src/main.tsx' })).toBe(
      SHELL_CHUNK_FILE_NAMES,
    );
    expect(chunkFileNames({ facadeModuleId: '/repo/apps/web/src/lib/offline.ts' })).toBe(
      SHELL_CHUNK_FILE_NAMES,
    );

    // 产物路径约定：页面 chunk 必须在 pages 子目录，壳层不得带 pages
    expect(PAGE_CHUNK_FILE_NAMES).toMatch(/^assets\/pages\//);
    expect(SHELL_CHUNK_FILE_NAMES).not.toContain('pages');
  });

  it('vite.config 使用共享的 chunkFileNames，且预缓存只含壳层资源', () => {
    expect(configSource).toContain("import { chunkFileNames } from './build/page-chunk'");

    const m = configSource.match(/globPatterns:\s*\[([\s\S]*?)\]/);
    expect(m).toBeTruthy();
    const patterns = m![1];

    // 壳层：入口 HTML/JS/CSS、图标、manifest
    expect(patterns).toContain("'index.html'");
    expect(patterns).toContain("'assets/*.{js,css}'");
    expect(patterns).toContain("'manifest.webmanifest'");

    // 回归：全量 glob 会把页面 chunk 拉回预缓存（355.8KiB 安装流量）
    expect(patterns).not.toContain('**/*');
    expect(patterns).not.toContain('assets/pages');
  });

  it('页面 chunk 走运行时 CacheFirst，已访问路由离线可回退', () => {
    // urlPattern 匹配 assets/pages 下的 JS
    const m = configSource.match(/urlPattern:\s*(\/\\\/assets\\\/pages\\\/[^,]+)/);
    expect(m).toBeTruthy();
    const pattern = new Function(`return ${m![1]}`)() as RegExp;
    expect(pattern.test('/assets/pages/index-Db25zR9C.js')).toBe(true);
    expect(pattern.test('/assets/index-DtZokYgb.js')).toBe(false);
    expect(pattern.test('/api/plan')).toBe(false);

    // 规则使用 CacheFirst + 独立 cacheName，且有上限防止无限膨胀
    expect(configSource).toContain("cacheName: 'page-chunks'");
    expect(configSource).toContain('maxEntries');
  });
});
