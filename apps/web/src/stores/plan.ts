import { create } from 'zustand';
import type { PlanDto } from '@ladder/shared';
import { apiGet } from '../lib/offline';

interface PlanState {
  plan: PlanDto | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

/** 当前三阶段计划（FR-01/FR-06；在线以服务端为准，断网回退 IndexedDB 快照） */
export const usePlanStore = create<PlanState>((set) => ({
  plan: null,
  loaded: false,
  refresh: async () => {
    try {
      const plan = await apiGet<PlanDto | null>('/plans/current');
      set({ plan, loaded: true });
    } catch {
      // 拉取失败也结束加载态，避免页面永久停在“加载中…”
      set({ plan: null, loaded: true });
    }
  },
}));
