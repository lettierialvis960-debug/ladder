import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatsPage } from '../pages/Stats';
import { api } from '../api/client';

vi.mock('../api/client', () => ({ api: vi.fn() }));
vi.mock('../stores/auth', () => ({
  useAuthStore: (selector: (s: any) => any) =>
    selector({ token: 'fake-jwt', logout: vi.fn(), setToken: vi.fn() }),
}));

const mockedApi = vi.mocked(api);

/** P2-12：7 个接口并发，全部 settle 后一次性渲染，消除连环布局偏移（CLS） */
describe('StatsPage 加载渲染（P2-12 CLS 修复）', () => {
  beforeEach(() => {
    mockedApi.mockReset();
  });

  it('全部接口完成前显示固定加载占位，完成后一次性渲染全部卡片', async () => {
    let resolveSlowest: (v: unknown) => void;
    const slowest = new Promise((r) => { resolveSlowest = r; });

    mockedApi.mockImplementation((path: string) => {
      if (path.startsWith('/stats/activity')) return slowest as Promise<never>;
      if (path.startsWith('/stats/weekly'))
        return Promise.resolve({
          startDate: '2026-10-27', endDate: '2026-11-02',
          days: [], totals: { listenMin: 0, checkedDays: 0, dictationCount: 0, dictationAvgRate: 0, speakingCount: 0 },
          weakWords: [], stage: null,
        }) as Promise<never>;
      if (path.startsWith('/stats/summary'))
        return Promise.resolve({ totalListenMin: 0, dictationSentenceCount: 0, dictationAvgCorrectRate: 0, speakingRecordCount: 0 }) as Promise<never>;
      return Promise.resolve(path.includes('calendar') ? [] : null) as Promise<never>;
    });

    render(<StatsPage />);

    // 其余 6 个接口已返回，但 activity 未 settle —— 页面必须保持加载占位，
    // 不允许卡片分批插入（回归：逐卡插入会造成连续布局偏移）
    await screen.findByText('正在加载统计数据…');
    expect(screen.queryByText('本周学习报告')).not.toBeInTheDocument();

    resolveSlowest!({ startDate: '2026-10-27', endDate: '2026-11-02', events: [] });

    // 全部 settle 后卡片一次性出现
    expect(await screen.findByText('本周学习报告')).toBeInTheDocument();
    expect(screen.getByText('累计统计')).toBeInTheDocument();
    expect(screen.queryByText('正在加载统计数据…')).not.toBeInTheDocument();
  });

  it('部分接口失败时仍渲染成功卡片并显示错误横幅', async () => {
    mockedApi.mockImplementation((path: string) => {
      if (path.startsWith('/stats/weekly')) return Promise.reject(new Error('服务器错误')) as Promise<never>;
      if (path.startsWith('/stats/summary'))
        return Promise.resolve({ totalListenMin: 12, dictationSentenceCount: 0, dictationAvgCorrectRate: 0, speakingRecordCount: 0 }) as Promise<never>;
      return Promise.resolve(path.includes('calendar') ? [] : null) as Promise<never>;
    });

    render(<StatsPage />);

    expect(await screen.findByText('统计加载不完整')).toBeInTheDocument();
    expect(screen.getByText(/1 项统计加载失败：服务器错误/)).toBeInTheDocument();
    // 成功的卡片（累计统计）正常渲染，失败的不阻塞整页
    expect(screen.getByText(/累计有效听时长：12 分钟/)).toBeInTheDocument();
  });
});
