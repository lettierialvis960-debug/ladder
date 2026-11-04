import { create } from 'zustand';
import { StageType } from '@ladder/shared';

interface PlayerState {
  currentItemId: string | null;
  playing: boolean;
  playbackRate: number; // 0.75 / 1.0 / 1.25（FR-03）
  transcriptVisible: boolean; // 阶段一默认盲听（FR-03 产品判断）
  setItem: (itemId: string | null) => void;
  setPlaying: (playing: boolean) => void;
  cycleRate: () => void;
  toggleTranscript: () => void;
}

const RATES = [1, 1.25, 0.75]; // 默认 1.0 起步的循环顺序

/** 听力播放器全局状态（连播队列与有效时长上报在 ListenPage 接入 effectiveTimeTracker） */
export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentItemId: null,
  playing: false,
  playbackRate: 1,
  transcriptVisible: false,
  setItem: (currentItemId) => set({ currentItemId }),
  setPlaying: (playing) => set({ playing }),
  cycleRate: () => {
    const idx = RATES.indexOf(get().playbackRate);
    set({ playbackRate: RATES[(idx + 1) % RATES.length] });
  },
  toggleTranscript: () => set((s) => ({ transcriptVisible: !s.transcriptVisible })),
}));

export { StageType };
