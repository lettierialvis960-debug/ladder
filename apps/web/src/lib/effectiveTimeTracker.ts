import { BACKGROUND_TOLERANCE_SEC } from '@ladder/shared';

/**
 * SR-01 有效听时长追踪器。
 * 口径（PRD 第 7 节）：
 *  - 仅音频实际播放时累计；暂停、静音、切后台超过 BACKGROUND_TOLERANCE_SEC 即停止；
 *  - 倍速按实际播放秒数计（不折算）；
 *  - 单日上限由服务端兜底（DAILY_LISTEN_CAP_MIN）。
 */
export class EffectiveTimeTracker {
  private audio: HTMLAudioElement;
  private accumulated = 0;      // 本次会话已累计秒数
  private lastTick: number | null = null;
  private backgroundSince: number | null = null;
  private removeListeners: Array<() => void> = [];

  constructor(audio: HTMLAudioElement) {
    this.audio = audio;
    const on = <K extends keyof HTMLMediaElementEventMap>(el: HTMLAudioElement, ev: K, fn: () => void) => {
      el.addEventListener(ev, fn);
      this.removeListeners.push(() => el.removeEventListener(ev, fn));
    };
    on(audio, 'timeupdate', () => this.tick());
    on(audio, 'pause', () => this.flush());
    on(audio, 'ended', () => this.flush());
    on(audio, 'volumechange', () => this.flush());

    const onVis = () => {
      if (document.hidden) {
        this.backgroundSince = Date.now();
      } else {
        this.backgroundSince = null;
        this.lastTick = null; // 回前台重新开始计段
      }
    };
    document.addEventListener('visibilitychange', onVis);
    this.removeListeners.push(() => document.removeEventListener('visibilitychange', onVis));
  }

  private counting(): boolean {
    if (this.audio.paused || this.audio.muted || this.audio.volume === 0) return false;
    if (this.backgroundSince !== null && Date.now() - this.backgroundSince > BACKGROUND_TOLERANCE_SEC * 1000) return false;
    return true;
  }

  private tick() {
    const now = performance.now();
    if (this.counting() && this.lastTick !== null) {
      // timeupdate 间隔约 250ms；按墙钟增量累计，异常大跳变（seek）截断到 1s
      const delta = Math.min((now - this.lastTick) / 1000, 1);
      if (delta > 0) this.accumulated += delta;
    }
    this.lastTick = now;
  }

  /** 取出并清零已累计秒数（供定时上报 /learning/listening） */
  flush(): number {
    this.tick();
    const sec = Math.floor(this.accumulated);
    this.accumulated -= sec;
    this.lastTick = null;
    return sec;
  }

  destroy() {
    this.removeListeners.forEach((off) => off());
    this.removeListeners = [];
  }
}
