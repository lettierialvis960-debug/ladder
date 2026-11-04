import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { router } from '../router';
import routerSource from '../router.tsx?raw';

// ---------- 依赖 mock（与 App.test.tsx 保持一致） ----------
vi.mock('../stores/auth', () => ({
  useAuthStore: (selector: (s: any) => any) =>
    selector({ token: 'fake-jwt', logout: vi.fn(), setToken: vi.fn() }),
}));
vi.mock('../lib/reminder', () => ({ initReminderScheduler: vi.fn() }));

describe('router.tsx 路由级代码分割（P2-10 首屏性能）', () => {
  it('除 index（今日页）外的页面全部通过 lazy + import() 按需加载', () => {
    const lazyCount = (routerSource.match(/lazy\(\(\) => import\('\.\/pages\//g) || []).length;
    expect(lazyCount).toBe(15);

    // 回归：任何页面重新变回静态 import 都会让该页代码回到首屏 chunk
    const staticPageImports = [...routerSource.matchAll(/import\s*\{[^}]*\}\s*from\s*'\.\/pages\/(\w+)'/g)].map((m) => m[1]);
    expect(staticPageImports).toEqual(['Today']);
  });

  it('懒加载路由可正常渲染：/plan-complete 触发按需加载并显示页面内容', async () => {
    await act(async () => {
      await router.navigate('/plan-complete');
    });
    render(<RouterProvider router={router} />);

    expect(await screen.findByText(/计划完成/)).toBeInTheDocument();
    // App 外壳与导航在懒加载期间保持渲染
    expect(screen.getByRole('heading', { level: 1, name: 'Ladder' })).toBeInTheDocument();
  });
});
