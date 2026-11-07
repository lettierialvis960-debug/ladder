import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.useFakeTimers();

const { tryRefreshMock } = vi.hoisted(() => ({
  tryRefreshMock: vi.fn(async () => 'refreshed-token'),
}));

vi.mock('../api/client', () => ({
  decodeExp: vi.fn((token: string) => (token === 'bad' ? null : 1_000_000_000)),
  tryRefresh: tryRefreshMock,
  PROACTIVE_REFRESH_WINDOW_MS: 24 * 60 * 60 * 1000,
}));

// exp = 1_000_000_000s；把系统时间设为 30 秒前，刷新窗口 24h → 5s 后触发
vi.setSystemTime(new Date(1_000_000_000 * 1000 - 30_000));

import { useAuthStore } from '../stores/auth';

describe('auth store 静默续期', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().logout();
    vi.clearAllMocks();
  });

  it('setToken 后到达刷新窗口会调用 tryRefresh', async () => {
    useAuthStore.getState().setToken('token-a');
    await vi.advanceTimersByTimeAsync(6000);
    expect(tryRefreshMock).toHaveBeenCalledTimes(1);
  });

  it('logout 后不再触发续期', async () => {
    useAuthStore.getState().setToken('token-a');
    useAuthStore.getState().logout();
    tryRefreshMock.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tryRefreshMock).not.toHaveBeenCalled();
  });
});
