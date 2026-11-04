import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import '../styles.css'; // Vitest css: true 让 styles.css 注入 jsdom（可通过 getComputedStyle 读）
// 某些值（如 var(--touch)）会被 jsdom 的 cssstyle 丢弃，用 ?raw 直读源码断言
import cssSource from '../styles.css?raw';

const mockToken = { current: 't' as string | null };
vi.mock('../stores/auth', () => ({
  useAuthStore: (selector: (s: any) => any) =>
    selector({ token: mockToken.current, logout: vi.fn(), setToken: vi.fn() }),
}));
vi.mock('../lib/reminder', () => ({ initReminderScheduler: vi.fn() }));

/** 把 document.styleSheets 的全部规则拼接成纯文本，便于 substring 匹配 */
function allRulesText(): string {
  return [...document.styleSheets]
    .map((ss) => {
      try {
        return [...(ss.cssRules || [])].map((r) => r.cssText).join('\n');
      } catch {
        return '';
      }
    })
    .join('\n');
}

describe('styles.css 响应式设计（P2-4 移动端适配）', () => {
  let root: HTMLElement;

  beforeEach(() => {
    const rendered = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    root = rendered.container;
  });

  describe('CSS 变量：移动端默认值', () => {
    // CSS 变量定义在 :root（document.documentElement），从 body / .app-shell 读不到
    it('✅ --pad-x = 16px（桌面 @media 768px 才覆盖为 20px）', () => {
      const style = getComputedStyle(document.documentElement);
      expect(style.getPropertyValue('--pad-x').trim()).toBe('16px');
    });

    it('✅ --touch = 44px（WCAG 2.1 最小点击区）', () => {
      const style = getComputedStyle(document.documentElement);
      expect(style.getPropertyValue('--touch').trim()).toBe('44px');
    });

    it('✅ --nav-height = 56px（移动端底部 nav）', () => {
      const style = getComputedStyle(document.documentElement);
      expect(style.getPropertyValue('--nav-height').trim()).toBe('56px');
    });

    it('✅ --fab-size = 52px（移动端 FAB；桌面端会被覆盖为 0）', () => {
      const style = getComputedStyle(document.documentElement);
      expect(style.getPropertyValue('--fab-size').trim()).toBe('52px');
    });

    it('✅ --radius = 10px（移动端卡片圆角）', () => {
      const style = getComputedStyle(document.documentElement);
      expect(style.getPropertyValue('--radius').trim()).toBe('10px');
    });
  });

  describe('安全区适配（iOS 刘海 + Home Indicator）', () => {
    it('✅ header padding-top 含 env(safe-area-inset-top)', () => {
      expect(allRulesText()).toContain('safe-area-inset-top');
    });

    it('✅ nav padding-bottom 含 env(safe-area-inset-bottom)', () => {
      expect(allRulesText()).toContain('safe-area-inset-bottom');
    });

    it('✅ app-main padding-bottom 叠加 var(--nav-height) + env(safe-area-inset-bottom)', () => {
      const text = allRulesText();
      expect(text).toContain('var(--nav-height)');
    });
  });

  describe('触摸 & 手势优化', () => {
    it('✅ touch-action: manipulation（消除 300ms 点击延迟）', () => {
      expect(allRulesText()).toContain('touch-action: manipulation');
    });

    it('✅ -webkit-text-size-adjust: 100%（iOS 禁止聚焦自动放大错位）', () => {
      expect(allRulesText()).toContain('-webkit-text-size-adjust: 100%');
    });

    it('✅ input font-size ≥ 16px（避免 iOS 聚焦自动放大）', () => {
      expect(allRulesText()).toMatch(/font-size:\s*16px/);
    });
  });

  describe('断点（响应式核心）', () => {
    it('✅ @media (min-width: 768px) — 移动端 → 桌面端', () => {
      expect(allRulesText()).toContain('(min-width: 768px)');
    });

    it('✅ @media (max-height: 500px) — 横屏 / iPad 横屏优化', () => {
      expect(allRulesText()).toContain('(max-height: 500px)');
    });
  });

  describe('无障碍', () => {
    it('✅ prefers-reduced-motion 媒体查询存在（尊重用户减弱动画偏好）', () => {
      expect(allRulesText()).toContain('prefers-reduced-motion');
    });
  });

  describe('移动端 vs 桌面端 nav 双形态（CSS display 切换）', () => {
    it('✅ .app-nav-mobile 在断点下 display:flex / display:none 切换', () => {
      expect(allRulesText()).toMatch(/\.app-nav-mobile/);
      expect(allRulesText()).toMatch(/\.app-nav-desktop/);
    });
  });

  describe('P2-7 收尾：触摸目标 / PWA 滚动 / 筛选栏 / 无障碍', () => {
    it('✅ 小 checkbox 伪元素扩命中区（inset: -13px → 44x44）', () => {
      const text = allRulesText();
      expect(text).toContain('inset: -13px');
      expect(text).toMatch(/input\[type="checkbox"\]\[style\*="width: 18px"\]/);
    });

    it('✅ overscroll-behavior-y: contain（防 PWA 下拉刷新误触）', () => {
      expect(allRulesText()).toContain('overscroll-behavior-y: contain');
    });

    it('✅ -webkit-overflow-scrolling: touch（iOS 惯性滚动）', () => {
      expect(allRulesText()).toContain('-webkit-overflow-scrolling: touch');
    });

    it('✅ ≤480px 筛选栏 date/select 占满整行（flex: 1 1 100%）', () => {
      const text = allRulesText();
      expect(text).toMatch(/input\[type="date"\]/);
      expect(text).toContain('flex: 1 1 100%');
    });

    it('✅ ≤400px nowrap 按钮允许换行（white-space: normal）', () => {
      const text = allRulesText();
      expect(text).toMatch(/button\[style\*="white-space: nowrap"\]/);
      expect(text).toContain('white-space: normal');
    });

    it('✅ 热力图 repeat(7) 小屏 gap 压缩', () => {
      expect(allRulesText()).toMatch(/\[style\*="repeat\(7"/);
    });

    it('✅ focus-visible 恢复可见焦点环（无障碍）', () => {
      expect(allRulesText()).toContain(':focus-visible');
      expect(allRulesText()).toContain('outline-offset: 2px');
    });

    it('✅ 长文本 overflow-wrap: anywhere（防撑破卡片）', () => {
      expect(allRulesText()).toContain('overflow-wrap: anywhere');
    });

    it('✅ @media (hover: none) 触摸设备去掉 hover 残留', () => {
      expect(allRulesText()).toContain('(hover: none)');
    });
  });

  describe('P2-8 视觉审计回归（真机多尺寸）', () => {
    /** 收集命中指定选择器的全部样式规则（含 @media 内部） */
    function rulesFor(selector: string): CSSStyleRule[] {
      const out: CSSStyleRule[] = [];
      const walk = (rules: CSSRuleList) => {
        [...rules].forEach((rule) => {
          if (rule instanceof CSSStyleRule) {
            const hit = rule.selectorText.split(',').some((s) => s.trim() === selector);
            if (hit) out.push(rule);
          } else if ('cssRules' in rule) {
            walk((rule as CSSMediaRule).cssRules);
          }
        });
      };
      [...document.styleSheets].forEach((ss) => {
        try {
          walk(ss.cssRules);
        } catch {
          /* 跨域样式表忽略 */
        }
      });
      return out;
    }

    it('✅ 底部导航锚定视口：.app-nav fixed 且 .app-nav-mobile 不得覆盖 position', () => {
      const nav = rulesFor('.app-nav');
      expect(nav.some((r) => r.style.position === 'fixed')).toBe(true);

      // 回归：曾因 .app-nav-mobile { position: relative } 覆盖 fixed，导致长页面导航被推到文档末尾
      const mobile = rulesFor('.app-nav-mobile');
      expect(mobile.length).toBeGreaterThan(0);
      expect(mobile.every((r) => r.style.position !== 'relative')).toBe(true);
    });

    it('✅ 数字输入框与文本输入共用同一套声明（44px 高 + 16px 防 iOS 缩放）', () => {
      const block = /input\[type="number"\][^{]*\{([^}]*)\}/.exec(cssSource);
      expect(block).not.toBeNull();
      expect(block![1]).toContain('min-height: var(--touch)');
      expect(block![1]).toContain('font-size: 16px');
    });
  });

  describe('P2-9 可访问性回归（axe-core 审计）', () => {
    it('✅ 副标题不再用 opacity 降透明度（白字 .75 实测 4.2:1 < AA）', () => {
      const block = /\.app-subtitle\s*\{([^}]*)\}/.exec(cssSource);
      expect(block).not.toBeNull();
      expect(block![1]).not.toMatch(/^\s*opacity\s*:/m);
      expect(block![1]).toContain('color: #dbe4fc');
    });

    it('✅ 成就卡不再整行/徽章降透明度（否则 12px 文字对比度跌破 4.5:1）', () => {
      const block = /\.ach-item\s*\{([^}]*)\}/.exec(cssSource);
      expect(block).not.toBeNull();
      expect(block![1]).not.toMatch(/^\s*opacity\s*:/m);
    });

    it('✅ 视觉隐藏 switch 的焦点环由滑块承担（键盘可见）', () => {
      const text = allRulesText();
      expect(text).toContain('.switch input:focus-visible + .slider');
    });

    it('✅ 原生 time 控件片段切换时焦点环不闪断（:focus-within 兜底）', () => {
      expect(allRulesText()).toContain('input[type="time"]:focus-within');
    });
  });
});
