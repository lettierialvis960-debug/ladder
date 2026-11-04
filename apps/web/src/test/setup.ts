/**
 * Vitest 测试环境 setup
 * - 注入 jest-dom 匹配器（.toBeInTheDocument / .toHaveClass 等）
 * - 全局 matchMedia / localStorage / ResizeObserver 兜底
 */
import '@testing-library/jest-dom';
import { vi } from 'vitest';

// jsdom 默认没有 Service Worker —— App 本身不注册 SW，这里只保底
Object.defineProperty(globalThis.navigator, 'serviceWorker', {
  value: undefined,
  writable: true,
  configurable: true,
});

// jsdom 缺 matchMedia —— CSS @media 断点断言需要
if (!globalThis.matchMedia) {
  globalThis.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// ResizeObserver 兜底（部分组件库会用到）
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
}
