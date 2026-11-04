import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ContentItemDto, ContentSearchDto, SentenceDto, TodayTaskDto } from '@ladder/shared';
import { api } from '../../api/client';
import { usePlanStore } from '../../stores/plan';
import { usePlayerStore } from '../../stores/player';
import { EffectiveTimeTracker } from '../../lib/effectiveTimeTracker';
import { todayLocal } from '../../lib/date';
import { getPlayableUrl, apiGet } from '../../lib/offline';
import { ProgressRing } from '../../components/ProgressRing';

/** 有效时长上报间隔：Tracker 按段累计，定时 flush 上报，避免切页丢数据（SR-01） */
const REPORT_INTERVAL_MS = 15_000;

/**
 * FR-03 阶段一 · 沉浸听力。
 * 泛听清单连播 + EffectiveTimeTracker 按口径累计有效时长 → 定时 POST /learning/listening；
 * 达标 DAILY_LISTEN_GOAL_MIN 由服务端自动打卡（SR-02）。默认盲听，文稿可手动展开。
 */
export function ListenPage() {
  const { plan, loaded, refresh } = usePlanStore();
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const cycleRate = usePlayerStore((s) => s.cycleRate);
  const transcriptVisible = usePlayerStore((s) => s.transcriptVisible);
  const toggleTranscript = usePlayerStore((s) => s.toggleTranscript);

  const [items, setItems] = useState<ContentItemDto[]>([]);
  const [index, setIndex] = useState(0);
  const [today, setToday] = useState<TodayTaskDto | null>(null);
  const [playableUrl, setPlayableUrl] = useState<string>('');
  const [error, setError] = useState('');
  /** 清单是「加载失败」还是「确实为空」需区分，失败时提供重试 */
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // P1「没听懂」：文稿逐句清单 + 已标记句子 id 集合
  const [sentences, setSentences] = useState<SentenceDto[]>([]);
  const [confusedIds, setConfusedIds] = useState<Set<string>>(new Set());
  // F2 句子收藏：已收藏句子 id 集合
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  // I2 内容搜索：关键词、结果、加载态与命中的句子高亮
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<ContentSearchDto | null>(null);
  const [searching, setSearching] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  // 当前句：文稿中选中的句子，其下方提供「朗读本句」按钮
  const [activeSentenceId, setActiveSentenceId] = useState<string | null>(null);
  const [playingSentenceId, setPlayingSentenceId] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackerRef = useRef<EffectiveTimeTracker | null>(null);
  const itemRef = useRef<ContentItemDto | null>(null);
  const reportingRef = useRef(false);
  const sentenceAudioRef = useRef<HTMLAudioElement | null>(null);
  // P1-1 锁屏媒体控制：Media Session 的 action handler 只绑一次，通过 ref 读取最新清单
  const itemsRef = useRef<ContentItemDto[]>([]);
  // P1-2 高亮跟随：手动选句后的宽限期（期间暂停自动跟随），与上一次跟随到的 seq（去重）
  const manualUntilRef = useRef(0);
  const lastFollowSeqRef = useRef<number | null>(null);

  useEffect(() => { if (!loaded) refresh().catch(() => {}); }, [loaded, refresh]);

  const refreshToday = useCallback(() => {
    api<TodayTaskDto>('/stats/today').then(setToday).catch(() => {});
  }, []);
  useEffect(() => { refreshToday(); }, [refreshToday]);

  // 计划 → 泛听清单（B1：并入我的自定义材料）
  useEffect(() => {
    if (!plan) return;
    Promise.all([
      apiGet<ContentItemDto[]>(`/content/items?packId=${plan.packId}&list=listening`),
      api<ContentItemDto[]>('/content/my-items?list=listening').catch(() => [] as ContentItemDto[]),
    ])
      .then(([official, mine]) => {
        // 计划包材料与「我的材料」可能重叠（自定义包同时属于计划），按 id 去重避免重复篇目
        const list = [...new Map([...official, ...mine].map((it) => [it.id, it])).values()];
        setItems(list);
        setIndex(0);
        setLoadFailed(false);
        setError(list.length ? '' : '该内容包暂无听力材料');
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : '加载失败');
        setLoadFailed(true);
      });
  }, [plan, reloadKey]);

  // 有效时长追踪器：用回调 ref 绑定。audio 元素要等 loaded && plan 后才挂载，
  // 普通 useEffect([]) 会先于元素执行从而漏绑，之后又不再重跑。
  const setAudioEl = useCallback((el: HTMLAudioElement | null) => {
    trackerRef.current?.destroy();
    trackerRef.current = null;
    audioRef.current = el;
    if (el) trackerRef.current = new EffectiveTimeTracker(el);
  }, []);

  const report = useCallback(async (sec: number, itemId: string) => {
    await api('/learning/listening', {
      method: 'POST',
      body: JSON.stringify({ itemId, date: todayLocal(), effectiveSec: sec }),
    });
    refreshToday();
  }, [refreshToday]);

  // 定时上报已累计有效秒数
  useEffect(() => {
    const timer = window.setInterval(async () => {
      const tracker = trackerRef.current;
      const item = itemRef.current;
      if (!tracker || !item || reportingRef.current) return;
      const sec = tracker.flush();
      if (sec <= 0) return;
      reportingRef.current = true;
      try { await report(sec, item.id); } catch { /* 网络抖动：该段丢弃，下次继续 */ }
      finally { reportingRef.current = false; }
    }, REPORT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [report]);

  useEffect(() => { itemRef.current = items[index] ?? null; }, [items, index]);
  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = playbackRate; }, [playbackRate, index]);

  const current = items[index] ?? null;

  // P1-1 锁屏媒体控制：切篇时更新 MediaSession 元数据（标题/艺术家/封面），
  // 让锁屏/通知栏显示当前篇目并支持上一首/下一首/播放暂停
  useEffect(() => {
    if (!current || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.title,
        artist: current.packTitle || 'Ladder',
        album: 'Ladder · 三步听力法',
        artwork: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
      });
    } catch { /* 个别环境构造失败时静默 */ }
  }, [current]);

  // I2 内容搜索：250ms 防抖，限定当前计划包 + 本人材料、听力清单
  useEffect(() => {
    const q = query.trim();
    if (!q || !plan) { setSearch(null); return; }
    const timer = window.setTimeout(() => {
      setSearching(true);
      api<ContentSearchDto>(`/content/search?q=${encodeURIComponent(q)}&packId=${plan.packId}&list=listening`)
        .then(setSearch)
        .catch(() => setSearch(null))
        .finally(() => setSearching(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, plan]);

  // P1 离线：把当前材料原始路径解析为可播放地址（已缓存→objectURL，未缓存→回源网络）
  useEffect(() => {
    let alive = true;
    if (!current?.audioUrl) { setPlayableUrl(''); return; }
    void getPlayableUrl(current.audioUrl).then((u) => { if (alive) setPlayableUrl(u); });
    return () => { alive = false; };
  }, [current]);

  // P1「没听懂」：展开文稿时拉逐句切片 + 已标记集合（换篇时重置）
  useEffect(() => {
    if (!transcriptVisible || !current) { setSentences([]); return; }
    let alive = true;
    lastFollowSeqRef.current = null; // 换篇重置跟随状态
    manualUntilRef.current = 0;
    apiGet<SentenceDto[]>(`/content/items/${current.id}/sentences`)
      .then((list) => { if (alive) setSentences(list); })
      .catch(() => {});
    api<{ sentence: { id: string } }[]>('/learning/confused')
      .then((list) => { if (alive) setConfusedIds(new Set(list.map((m) => m.sentence.id))); })
      .catch(() => {});
    api<{ sentence: { id: string } }[]>('/learning/favorites')
      .then((list) => { if (alive) setFavoriteIds(new Set(list.map((f) => f.sentence.id))); })
      .catch(() => {});
    return () => { alive = false; };
  }, [transcriptVisible, current]);

  // 当前句跟随：搜索命中优先，其次保持原选中，否则落到第一句
  useEffect(() => {
    if (!transcriptVisible || sentences.length === 0) { setActiveSentenceId(null); return; }
    setActiveSentenceId((prev) => {
      if (prev && sentences.some((s) => s.id === prev)) return prev;
      const hit = focusId ? sentences.find((s) => s.id === focusId) : undefined;
      return (hit ?? sentences[0]).id;
    });
  }, [transcriptVisible, sentences, focusId]);

  /** P1-2 手动选句：立即高亮 + 8s 宽限期内暂停自动跟随，避免与用户操作打架 */
  const pickSentence = useCallback((sentenceId: string) => {
    setActiveSentenceId(sentenceId);
    manualUntilRef.current = Date.now() + 8000;
  }, []);

  // P1-2 逐句高亮跟随：整篇播放时按时间轴把「当前句」推进到正在播的句子
  // （官方慢/快交替材料由 rebuild 脚本生成精确 startSec；自定义材料无 timeline 自动跳过）
  const followTimeline = useCallback(() => {
    const el = audioRef.current;
    const tl = itemRef.current?.timeline;
    if (!el || !tl?.length || !transcriptVisible || !sentences.length) return;
    if (sentenceAudioRef.current) return; // 句朗读进行中不跟随
    if (Date.now() < manualUntilRef.current) return; // 手动选择宽限期
    // 时间轴按播放顺序有序：二分找最后一个 startSec <= currentTime 的点
    const t = el.currentTime;
    let lo = 0;
    let hi = tl.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tl[mid].startSec <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (ans < 0) return;
    const seq = tl[ans].seq;
    if (seq === lastFollowSeqRef.current) return;
    lastFollowSeqRef.current = seq;
    const s = sentences.find((x) => x.seq === seq);
    if (s) setActiveSentenceId(s.id);
  }, [transcriptVisible, sentences]);

  // P1-2 跟随滚动：当前句变化时平滑滚动到可视区
  useEffect(() => {
    if (!transcriptVisible || !activeSentenceId) return;
    document.querySelector<HTMLElement>(`[data-sid="${activeSentenceId}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeSentenceId, transcriptVisible]);

  // 换篇/收起文稿时停掉句朗读，避免残留声音
  useEffect(() => {
    sentenceAudioRef.current?.pause();
    sentenceAudioRef.current = null;
    setPlayingSentenceId(null);
  }, [current?.id, transcriptVisible]);

  useEffect(() => () => { sentenceAudioRef.current?.pause(); }, []);

  /** P1「没听懂」：标记/取消标记（乐观更新，失败回滚） */
  const toggleConfused = useCallback(async (sentenceId: string) => {
    const marked = confusedIds.has(sentenceId);
    const flip = (add: boolean) => setConfusedIds((prev) => {
      const next = new Set(prev);
      if (add) next.add(sentenceId); else next.delete(sentenceId);
      return next;
    });
    flip(!marked);
    try {
      if (marked) await api(`/learning/confused/${sentenceId}`, { method: 'DELETE' });
      else await api('/learning/confused', { method: 'POST', body: JSON.stringify({ sentenceId }) });
    } catch {
      flip(marked);
    }
  }, [confusedIds]);

  /** F2 句子收藏：收藏/取消（乐观更新，失败回滚） */
  const toggleFavorite = useCallback(async (sentenceId: string) => {
    const favorited = favoriteIds.has(sentenceId);
    const flip = (add: boolean) => setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (add) next.add(sentenceId); else next.delete(sentenceId);
      return next;
    });
    flip(!favorited);
    try {
      if (favorited) await api(`/learning/favorites/${sentenceId}`, { method: 'DELETE' });
      else await api('/learning/favorites', { method: 'POST', body: JSON.stringify({ sentenceId }) });
    } catch {
      flip(favorited);
    }
  }, [favoriteIds]);

  /** 句朗读：播放当前句的切片音频（同一按钮再点即停）；与整篇播放互斥 */
  const playSentence = useCallback(async (sentence: SentenceDto) => {
    const el = sentenceAudioRef.current;
    if (playingSentenceId === sentence.id) {
      el?.pause();
      sentenceAudioRef.current = null;
      setPlayingSentenceId(null);
      return;
    }
    el?.pause();
    audioRef.current?.pause();
    // 乐观切换按钮态：先置为播放中，再异步解析可播放地址（离线优先）
    setPlayingSentenceId(sentence.id);
    try {
      const url = await getPlayableUrl(sentence.audioUrl);
      const audio = new Audio(url);
      audio.onended = () => { setPlayingSentenceId(null); };
      audio.onerror = () => { setPlayingSentenceId(null); };
      sentenceAudioRef.current = audio;
      await audio.play();
    } catch {
      sentenceAudioRef.current = null;
      setPlayingSentenceId(null);
    }
  }, [playingSentenceId]);

  const activeSentence = sentences.find((s) => s.id === activeSentenceId) ?? null;
  const activeIdx = activeSentence ? sentences.findIndex((s) => s.id === activeSentence.id) : -1;

  // 暂停 / 播完：立即结算未上报的尾段；播完自动切下一篇
  const settle = useCallback((ended: boolean) => {
    const tracker = trackerRef.current;
    const item = itemRef.current;
    if (tracker && item) {
      const sec = tracker.flush();
      if (sec > 0) report(sec, item.id).catch(() => {});
    }
    if (ended) setIndex((i) => (items.length ? (i + 1) % items.length : 0));
  }, [items.length, report]);

  // P1-1 锁屏媒体控制：绑定 MediaSession action handler（上一首/下一首/播放/暂停/快退/快进）。
  // handler 只绑一次，通过 ref 取最新状态，避免闭包过期
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const audio = () => audioRef.current;
    const goPrev = () => {
      const list = itemsRef.current;
      if (!list.length) return;
      settle(false);
      setIndex((i) => (i - 1 + list.length) % list.length);
    };
    const goNext = () => settle(true);
    const handlers: Partial<Record<MediaSessionAction, (d?: MediaSessionActionDetails) => void>> = {
      play: () => { void audio()?.play(); },
      pause: () => audio()?.pause(),
      previoustrack: goPrev,
      nexttrack: goNext,
      seekbackward: (d) => { const el = audio(); if (el) el.currentTime = Math.max(0, el.currentTime - (d?.seekOffset ?? 10)); },
      seekforward: (d) => { const el = audio(); if (el) el.currentTime += (d?.seekOffset ?? 10); },
    };
    (Object.keys(handlers) as MediaSessionAction[]).forEach((action) => {
      try { ms.setActionHandler(action, handlers[action] ?? null); } catch { /* 不支持的 action 静默 */ }
    });
    return () => {
      (Object.keys(handlers) as MediaSessionAction[]).forEach((action) => {
        try { ms.setActionHandler(action, null); } catch {}
      });
    };
  }, [settle]);

  /** I2 跳转到命中的材料：切换播放项、展开文稿并高亮命中句 */
  const jumpTo = useCallback((itemId: string, sentenceId: string | null) => {
    const idx = items.findIndex((it) => it.id === itemId);
    if (idx < 0) return;
    settle(false);
    setIndex(idx);
    if (!transcriptVisible) toggleTranscript();
    setFocusId(sentenceId);
    if (sentenceId) pickSentence(sentenceId);
    setQuery('');
    setSearch(null);
  }, [items, settle, transcriptVisible, toggleTranscript, pickSentence]);

  if (!loaded) return <p className="muted">加载中…</p>;
  if (!plan) {
    return (
      <div className="card">
        <h2>还没有学习计划</h2>
        <p className="muted">先创建三阶段计划，再开始沉浸听力。</p>
        <Link to="/onboarding"><button className="btn">创建计划</button></Link>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h2>阶段一 · 沉浸听力</h2>
        {today && (
          <ProgressRing
            value={today.goal ? today.progress / today.goal : 0}
            label={`${today.progress} / ${today.goal} 分钟`}
            sub={today.checkedIn ? `今日已打卡 · 连续 ${today.streakDays} 天` : '达标后自动打卡（SR-02）'}
          />
        )}
        <p className="muted">盲听优先：先不显示文稿，遇到听不懂的再展开对照；展开后可逐句标记「没听懂」，自动进复习队列（FR-03）。</p>
      </div>

      {/* I2 搜索：按材料标题或句子关键词定位，点击结果直接切篇并展开文稿 */}
      <div className="card">
        <h2>搜索听力内容</h2>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="输入材料标题或句子关键词，如：机场"
          style={{ width: '100%' }}
        />
        {searching && <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>搜索中…</p>}
        {!searching && search && (
          search.items.length + search.sentences.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              {search.items.map((it) => (
                <button
                  key={it.id}
                  className="btn ghost"
                  style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 6, padding: '8px 10px' }}
                  onClick={() => jumpTo(it.id, null)}
                >
                  <div><b>{it.title}</b></div>
                  <div className="muted" style={{ fontSize: 12 }}>《{it.packTitle}》 · {it.sentenceCount} 句</div>
                </button>
              ))}
              {search.sentences.map((s) => (
                <button
                  key={s.id}
                  className="btn ghost"
                  style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 6, padding: '8px 10px' }}
                  onClick={() => jumpTo(s.item.id, s.id)}
                >
                  <div>{s.text}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{s.translation}</div>
                  <div className="muted" style={{ fontSize: 12 }}>《{s.item.title}》</div>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ marginBottom: 0 }}>没有匹配的内容。</p>
          )
        )}
      </div>

      {!items.length && (
        <div className="card">
          <h2>{loadFailed ? '听力材料加载失败' : '听力清单还是空的'}</h2>
          <p className={loadFailed ? undefined : 'muted'} style={loadFailed ? { color: '#b42318' } : undefined}>
            {loadFailed ? error : '当前计划包没有可泛听的材料。可以在「我的材料」导入自己的内容，或到计划页更换内容包。'}
          </p>
          <div className="row">
            {loadFailed && (
              <button className="btn" onClick={() => setReloadKey((k) => k + 1)}>重试</button>
            )}
            <Link to="/materials"><button className={loadFailed ? 'btn ghost' : 'btn'}>去我的材料</button></Link>
            <Link to="/plan"><button className="btn ghost">查看计划</button></Link>
          </div>
        </div>
      )}
      {!!items.length && (
      <div className="card">
        <h2>{current ? current.title : '沉浸听力'}</h2>
        {current && (
          <div className="row">
            <button className="btn ghost" onClick={cycleRate}>倍速 {playbackRate}×</button>
            <button className="btn ghost" onClick={toggleTranscript}>
              {transcriptVisible ? '隐藏文稿' : '显示文稿'}
            </button>
            <span className="muted">{index + 1} / {items.length}</span>
          </div>
        )}
        {/* audio 常驻挂载：EffectiveTimeTracker 需在挂载时绑定播放器元素，切歌不重建；
            src 用离线解析后的 playableUrl（IndexedDB objectURL 或网络路径） */}
        <audio
          ref={setAudioEl}
          src={playableUrl}
          controls
          preload="metadata"
          style={{ width: '100%' }}
          onPlay={() => {
            sentenceAudioRef.current?.pause();
            sentenceAudioRef.current = null;
            setPlayingSentenceId(null);
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
          }}
          onPause={() => {
            settle(false);
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
          }}
          onEnded={() => settle(true)}
          onTimeUpdate={followTimeline}
        />
        {items.length > 1 && (
          <div className="row" style={{ gap: 6, marginTop: 10 }}>
            {items.map((it, i) => (
              <button
                key={it.id}
                className={i === index ? 'btn' : 'btn ghost'}
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => { settle(false); setIndex(i); setFocusId(null); }}
              >
                {it.title}
              </button>
            ))}
          </div>
        )}
        {transcriptVisible && current && (
          <div style={{ marginTop: 12 }}>
            {sentences.length > 0 ? (
              sentences.map((s) => (
                <div
                  key={s.id}
                  data-sid={s.id}
                  className="row"
                  onClick={() => pickSentence(s.id)}
                  style={{
                    justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, padding: '8px 0',
                    paddingLeft: 8,
                    borderBottom: '1px solid #eef1f6',
                    cursor: 'pointer',
                    background: activeSentenceId === s.id ? '#eef4ff' : focusId === s.id ? '#fff7ed' : undefined,
                    borderLeft: activeSentenceId === s.id ? '3px solid #1a56db' : '3px solid transparent',
                  }}
                >
                  <div>
                    <div>{s.text}</div>
                    <div className="muted">{s.translation}</div>
                  </div>
                  <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                    <button
                      className={favoriteIds.has(s.id) ? 'btn' : 'btn ghost'}
                      style={{ padding: '4px 10px', fontSize: 13, whiteSpace: 'nowrap' }}
                      onClick={() => toggleFavorite(s.id)}
                    >
                      {favoriteIds.has(s.id) ? '已收藏' : '收藏'}
                    </button>
                    <button
                      className={confusedIds.has(s.id) ? 'btn' : 'btn ghost'}
                      style={{ padding: '4px 10px', fontSize: 13, whiteSpace: 'nowrap' }}
                      onClick={() => toggleConfused(s.id)}
                    >
                      {confusedIds.has(s.id) ? '已标记听不懂' : '没听懂'}
                    </button>
                  </div>
                </div>
              ))
            ) : (
              // 句子接口不可用时回退整篇文稿，保证盲听对照不中断
              <>
                <div>{current.transcript}</div>
                <div className="muted">{current.translation}</div>
              </>
            )}
            {activeSentence && (
              <div
                style={{
                  marginTop: 12, padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc',
                }}
              >
                <div className="muted" style={{ fontSize: 12 }}>
                  当前句 · 第 {activeIdx + 1} / {sentences.length} 句
                </div>
                <div style={{ margin: '6px 0' }}>{activeSentence.text}</div>
                <div className="muted" style={{ fontSize: 13 }}>{activeSentence.translation}</div>
                <div className="row" style={{ marginTop: 10, gap: 8 }}>
                  <button className="btn" onClick={() => void playSentence(activeSentence)}>
                    {playingSentenceId === activeSentence.id ? '停止朗读' : '朗读本句'}
                  </button>
                  <button
                    className="btn ghost"
                    disabled={activeIdx <= 0}
                    onClick={() => { const p = sentences[activeIdx - 1]; if (p) pickSentence(p.id); }}
                  >
                    上一句
                  </button>
                  <button
                    className="btn ghost"
                    disabled={activeIdx < 0 || activeIdx >= sentences.length - 1}
                    onClick={() => { const n = sentences[activeIdx + 1]; if (n) pickSentence(n.id); }}
                  >
                    下一句
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
