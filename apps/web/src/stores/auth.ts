import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { decodeExp, PROACTIVE_REFRESH_WINDOW_MS } from '../api/client';

/** 静默续期定时器（内存态，不持久化） */
let renewTimer: ReturnType<typeof setTimeout> | null = null;

/** 续期失败后的重试间隔：避免网络/服务抖动时无限退避或直接掉线 */
const RENEW_RETRY_INTERVAL_MS = 10 * 60 * 1000;

function clearRenewTimer() {
  if (renewTimer) {
    clearTimeout(renewTimer);
    renewTimer = null;
  }
}

/** 根据 token 的 exp 安排下一次静默续期 */
function scheduleRenew(token: string | null) {
  clearRenewTimer();
  if (!token) return;
  const exp = decodeExp(token);
  if (!exp) return;
  const remaining = exp * 1000 - Date.now();
  // 过期前 24h 刷新；若剩余不足 24h，则 5s 后刷新（给启动留出时间）
  const refreshAt = Math.max(5000, remaining - PROACTIVE_REFRESH_WINDOW_MS);
  renewTimer = setTimeout(() => void doRenew(), refreshAt);
}

/** 执行一次静默续期；成功由 setToken 重新排程，失败延后重试 */
async function doRenew() {
  renewTimer = null;
  try {
    const { tryRefresh } = await import('../api/client');
    const ok = await tryRefresh();
    if (ok) return; // tryRefresh 内部已调用 setToken → 重新排程
  } catch {
    /* ignore, will retry */
  }
  renewTimer = setTimeout(() => void doRenew(), RENEW_RETRY_INTERVAL_MS);
}

interface AuthState {
  token: string | null;
  /** 登录态失效原因（如 token 过期），登录页据此给出提示；不持久化 */
  notice: string | null;
  setToken: (token: string) => void;
  logout: (reason?: string) => void;
  clearNotice: () => void;
}

/** 登录态（localStorage 持久化；SR-05：未登录仅可体验样本） */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      notice: null,
      setToken: (token) => {
        set({ token, notice: null });
        scheduleRenew(token);
      },
      clearNotice: () => set({ notice: null }),
      logout: (reason) => {
        clearRenewTimer();
        set({ token: null, notice: reason ?? null });
        // 登出同时清空离线元数据缓存 + SW API 数据缓存，防换账号串数据
        // （动态 import 避免与 client.ts 循环依赖）
        void import('../lib/offline')
          .then(async (m) => {
            await Promise.all([m.clearMeta(), m.clearApiDataCache()]);
          })
          .catch(() => {});
      },
    }),
    {
      name: 'ladder-auth',
      // 仅持久化 token：notice 属于一次性提示，刷新后不应再出现
      partialize: (s) => ({ token: s.token }),
      // 重新加载页面时，根据已恢复的 token 重建静默续期定时器
      onRehydrateStorage: () => (state) => {
        if (state?.token) scheduleRenew(state.token);
      },
    },
  ),
);
