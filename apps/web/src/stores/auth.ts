import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  token: string | null;
  setToken: (token: string) => void;
  logout: () => void;
}

/** 登录态（localStorage 持久化；SR-05：未登录仅可体验样本） */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      setToken: (token) => set({ token }),
      logout: () => {
        set({ token: null });
        // 登出同时清空离线元数据缓存，防换账号串数据（动态 import 避免与 client.ts 循环依赖）
        void import('../lib/offline')
          .then((m) => m.clearMeta())
          .catch(() => {});
      },
    }),
    { name: 'ladder-auth' },
  ),
);
