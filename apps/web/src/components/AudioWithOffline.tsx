import { useEffect, useState } from 'react';
import { getPlayableUrl, isCached } from '../lib/offline';

/**
 * 离线优先音频播放器（P1）。
 * src 传入原始路径，内部经 getPlayableUrl 解析：已缓存 → IndexedDB objectURL，未缓存 → 网络。
 * 已缓存时标题右侧显示「离线」标识。
 */
export function AudioWithOffline(props: {
  src: string;
  showOfflineBadge?: boolean;
  style?: React.CSSProperties;
  /** 外部读取 audio 元素（时间轴跟随需要 currentTime） */
  elRef?: React.MutableRefObject<HTMLAudioElement | null>;
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
  onTimeUpdate?: () => void;
}) {
  const { src, showOfflineBadge = true, style, elRef, onPlay, onPause, onEnded, onTimeUpdate } = props;
  const [playable, setPlayable] = useState<string>(src);
  const [cached, setCached] = useState(false);

  useEffect(() => {
    let alive = true;
    setCached(false);
    void getPlayableUrl(src).then((u) => { if (alive) setPlayable(u); });
    void isCached(src).then((c) => { if (alive) setCached(c); });
    return () => { alive = false; };
  }, [src]);

  return (
    <div>
      {showOfflineBadge && cached && (
        <span className="muted" style={{ fontSize: 12 }}>● 离线已缓存</span>
      )}
      <audio
        ref={elRef}
        src={playable}
        controls
        preload="metadata"
        style={{ width: '100%', ...style }}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEnded}
        onTimeUpdate={onTimeUpdate}
      />
    </div>
  );
}
