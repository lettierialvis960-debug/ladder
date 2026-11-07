import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
      setToken: (token) => set({ token, notice: null }),
      clearNotice: () => set({ notice: null }),
      logout: (reason) => {
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
    },
  ),
);
