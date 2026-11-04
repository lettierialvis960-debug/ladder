import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';

// ---------- 依赖 mock ----------
const mockToken = { current: null as string | null };
vi.mock('../stores/auth', () => ({
  useAuthStore: (selector: (s: any) => any) =>
    selector({ token: mockToken.current, logout: vi.fn(), setToken: vi.fn() }),
}));

vi.mock('../lib/reminder', () => ({
  initReminderScheduler: vi.fn(),
}));

function setToken(token: string | null) {
  mockToken.current = token;
}

function renderApp(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  );
}

describe('App.tsx 移动端适配', () => {
  describe('未登录态 → 跳登录页', () => {
    it('访问 /login 正常渲染（三步听力法文案）', () => {
      setToken(null);
      renderApp('/login');
      expect(screen.getByText(/三步听力法/)).toBeInTheDocument();
    });

    it('访问受保护路由 → Navigate 组件触发（不渲染底部 nav）', () => {
      setToken(null);
      const { container } = renderApp('/');
      expect(container.querySelector('.app-nav-mobile')).not.toBeInTheDocument();
      expect(container.querySelector('.app-nav-desktop')).not.toBeInTheDocument();
    });
  });

  describe('已登录态 → 底部双形态导航（P2-4 核心）', () => {
    let container: HTMLElement;

    beforeEach(() => {
      setToken('fake-jwt');
      const rendered = renderApp('/');
      container = rendered.container;
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('mobile nav 存在：4 个 .app-nav-item + 1 个 .app-nav-fab', () => {
      const mobileNav = container.querySelector('.app-nav-mobile');
      expect(mobileNav).toBeInTheDocument();
      expect(mobileNav!.querySelectorAll('.app-nav-item').length).toBe(4);
      expect(mobileNav!.querySelector('.app-nav-fab')).toBeInTheDocument();
    });

    it('mobile nav 4 tab 文案：今日 / 材料 / 统计 / 计划', () => {
      const mobileNav = container.querySelector('.app-nav-mobile')!;
      const labels = [...mobileNav.querySelectorAll('.app-nav-label')].map((el) => el.textContent?.trim());
      expect(labels).toEqual(['今日', '材料', '统计', '计划']);
    });

    it('FAB 链接到 /listen（核心 CTA：开始训练）', () => {
      const fab = container.querySelector('.app-nav-fab')!;
      expect(fab.getAttribute('href')).toBe('/listen');
    });

    it('desktop nav 存在：8 个 tab', () => {
      const desktopNav = container.querySelector('.app-nav-desktop');
      expect(desktopNav).toBeInTheDocument();
      expect(desktopNav!.querySelectorAll('a').length).toBe(8);
    });

    it('desktop 8 tab 完整：今日→错词本→专练→材料→小测→统计→离线→计划', () => {
      const desktopNav = container.querySelector('.app-nav-desktop')!;
      const texts = [...desktopNav.querySelectorAll('a')].map((a) => a.textContent?.trim());
      expect(texts).toEqual(['今日', '错词本', '专练', '材料', '小测', '统计', '离线', '计划']);
    });

    it('/ 路由 → mobile nav 第一个 tab（今日）带 .active 类', () => {
      const mobileNav = container.querySelector('.app-nav-mobile')!;
      const homeTab = mobileNav.querySelectorAll('.app-nav-item')[0];
      expect(homeTab.className).toMatch(/\bactive\b/);
    });

    it('/materials 路由 → 第二个 tab 激活，第一个不激活', () => {
      const { container: c2 } = renderApp('/materials');
      const mobileNav = c2.querySelector('.app-nav-mobile')!;
      const tabs = mobileNav.querySelectorAll('.app-nav-item');
      expect(tabs[1].className).toMatch(/\bactive\b/);
      expect(tabs[0].className).not.toMatch(/\bactive\b/);
    });

    it('header 设置 + 退出按钮可见', () => {
      expect(container.querySelector('.app-header-btn[title="设置"]')).toBeInTheDocument();
      expect(container.querySelector('.app-header-btn[title="退出"]')).toBeInTheDocument();
    });

    it('页面存在唯一 h1（Ladder），满足 WCAG 标题层级', () => {
      expect(screen.getByRole('heading', { level: 1, name: 'Ladder' })).toBeInTheDocument();
      expect(container.querySelectorAll('h1').length).toBe(1);
    });
  });
});
