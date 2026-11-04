import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Vitest 配置（继承 Vite 的 TS/alias 能力）
 * - jsdom 模拟浏览器环境（fetch, URL, localStorage 自动可用）
 * - global: true 让 describe/test/beforeEach 免 import
 * - setupFiles 注入 jest-dom 匹配器（.toBeInTheDocument 等）
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@ladder/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true, // 让 Vitest 处理 CSS（styles.css 的 @media 断点等可被 getComputedStyle 读取）
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.d.ts', 'src/test/**', 'src/main.tsx'],
    },
  },
});
