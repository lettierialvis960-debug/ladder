/**
 * P2-11：页面级懒加载 chunk 输出目录策略。
 * 抽成独立纯函数模块：vite.config.ts 与单测共用，
 * 避免测试 import vite.config 时连带加载 vite/esbuild（jsdom 环境下会崩溃）。
 */
export const PAGE_CHUNK_RE = /[\\/]src[\\/]pages[\\/]/;

export const PAGE_CHUNK_FILE_NAMES = 'assets/pages/[name]-[hash].js';
export const SHELL_CHUNK_FILE_NAMES = 'assets/[name]-[hash].js';

/** 页面懒加载 chunk → assets/pages/（从预缓存剥离）；其余 → assets/（壳层，预缓存） */
export function chunkFileNames(chunkInfo: { facadeModuleId: string | null }): string {
  return PAGE_CHUNK_RE.test(chunkInfo.facadeModuleId ?? '')
    ? PAGE_CHUNK_FILE_NAMES
    : SHELL_CHUNK_FILE_NAMES;
}
