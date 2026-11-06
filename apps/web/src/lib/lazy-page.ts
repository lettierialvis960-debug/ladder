import { lazy, type ComponentType } from 'react';

/** 重试前的等待时间：给瞬时断网/弱网恢复留出窗口，同时避免无限快速重试 */
const RETRY_DELAY_MS = 200;

/**
 * 带重试的模块加载。
 * P2-11 之后页面 chunk 不再进 SW 预缓存，改为运行时缓存：
 * 未访问过的页面在离线时必然拉取失败，这是设计意图；此处单次重试用于覆盖
 * 「部署后旧 chunk 404」「网络瞬时抖动」这类可自愈的失败，仍失败则抛给错误边界。
 */
export async function loadWithRetry<T>(factory: () => Promise<T>, retries = 1): Promise<T> {
  try {
    return await factory();
  } catch (error) {
    if (retries <= 0) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return loadWithRetry(factory, retries - 1);
  }
}

/** 页面懒加载入口：失败由 RouteErrorBoundary 渲染兜底页，而不是白屏 */
export function lazyPage<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(() => loadWithRetry(factory));
}
