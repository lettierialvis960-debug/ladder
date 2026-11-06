import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { loadWithRetry, lazyPage } from '../lib/lazy-page';
import { RouteErrorBoundary } from '../components/RouteErrorBoundary';

describe('loadWithRetry（P2-14 懒加载重试）', () => {
  it('首次失败后重试一次并返回结果', async () => {
    let calls = 0;
    const factory = async () => {
      calls++;
      if (calls === 1) throw new Error('chunk load failed');
      return 'ok';
    };
    await expect(loadWithRetry(factory)).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('重试后仍失败则抛出原始错误（不无限重试）', async () => {
    let calls = 0;
    const factory = async () => {
      calls++;
      throw new Error('offline and chunk not cached');
    };
    await expect(loadWithRetry(factory)).rejects.toThrow('offline and chunk not cached');
    expect(calls).toBe(2);
  });
});

describe('RouteErrorBoundary（P2-14 离线兜底页）', () => {
  const originalError = console.error;
  beforeEach(() => {
    // React 会把边界捕获的错误打到 console.error，测试里静默
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    console.error = originalError;
    vi.restoreAllMocks();
  });

  it('单个页面的 chunk 加载失败时渲染兜底页，而不是白屏', async () => {
    const BrokenPage = lazyPage(async () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    render(
      <MemoryRouter>
        <RouteErrorBoundary>
          <Suspense fallback={<p>加载中…</p>}>
            <BrokenPage />
          </Suspense>
        </RouteErrorBoundary>
      </MemoryRouter>,
    );

    expect(await screen.findByText('这个页面暂时打不开')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /返回今日/ })).toHaveAttribute('href', '/');
  });

  it('页面正常时不拦截渲染', () => {
    render(
      <MemoryRouter>
        <RouteErrorBoundary>
          <p>正常内容</p>
        </RouteErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByText('正常内容')).toBeInTheDocument();
  });
});
