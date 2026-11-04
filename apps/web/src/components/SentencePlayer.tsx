import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../stores/player';

interface SentencePlayerProps {
  src: string;
  /** FR-03：句内循环 / 减速（听写句播放器复用） */
  loop?: boolean;
  onEnded?: () => void;
}

/**
 * 句级播放器（阶段二听写 / 阶段三跟读共用）。
 * TODO[FR-03]：整篇连播播放器在此基础上扩展队列 + Media Session 锁屏信息。
 */
export function SentencePlayer({ src, loop = false, onEnded }: SentencePlayerProps) {
  const ref = useRef<HTMLAudioElement>(null);
  const rate = usePlayerStore((s) => s.playbackRate);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = rate;
  }, [rate]);

  return (
    <audio
      ref={ref}
      src={src}
      loop={loop}
      controls
      onEnded={onEnded}
      style={{ width: '100%' }}
    />
  );
}
