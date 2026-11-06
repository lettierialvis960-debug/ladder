import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { SpeakingType } from '@ladder/shared';
import type { ContentItemDto, SentenceDto, TodayTaskDto } from '@ladder/shared';
import { api, uploadFile } from '../../api/client';
import { usePlanStore } from '../../stores/plan';
import { todayLocal } from '../../lib/date';
import { apiGet } from '../../lib/offline';
import { AudioWithOffline } from '../../components/AudioWithOffline';

type Mode = 'READ' | 'RETELL';

/** Web Speech API 类型（Chrome/Edge 支持） */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: (e: any) => void;
  onerror: (e: any) => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/**
 * FR-05 阶段三 · 口语输出。
 * 跟读：句播放 → MediaRecorder 录音 → （可选 Web Speech API ASR 采 transcript）→ 上传 + POST /learning/speaking。
 * 复述：整篇无文稿播放 → 录音（type=RETELL），评分由服务端 SpeechScoringService 做时长启发式。
 * 评分返回 score + 可选 wordsFeedback（有 transcript 时 WER 词级反馈；无 transcript 时长启发式）。
 */
export function SpeakingPage() {
  const { plan, loaded, refresh } = usePlanStore();

  const [mode, setMode] = useState<Mode>('READ');
  const [items, setItems] = useState<ContentItemDto[]>([]);
  const [itemIdx, setItemIdx] = useState(0);
  const [sentences, setSentences] = useState<SentenceDto[]>([]);
  const [sentIdx, setSentIdx] = useState(0);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [micDenied, setMicDenied] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  /** D1：最近一次录音（含示范音频 + 后端评分） */
  const [last, setLast] = useState<{
    id: string; url: string; modelUrl: string;
    score?: number; wordsFeedback?: Array<{ word: string; ok: boolean }> | null;
  } | null>(null);
  const [rating, setRating] = useState(0);
  const [ratingBusy, setRatingBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [today, setToday] = useState<TodayTaskDto | null>(null);
  const [error, setError] = useState('');
  /** 逐句列表的当前高亮句（跟读=当前练习句；复述=按整篇时间轴跟随） */
  const [activeId, setActiveId] = useState('');
  /** 复述模式默认无文稿；需要跟读高亮时可手动显示 */
  const [showScript, setShowScript] = useState(false);
  const modelAudioRef = useRef<HTMLAudioElement | null>(null);
  /** 材料清单加载态：区分「加载中 / 加载失败 / 确实没有材料」 */
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  /** Web Speech API 是否可用（Chrome/Edge） */
  const speechAvailable = useRef<boolean>(typeof window !== 'undefined' && !!getSpeechRecognition());

  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const modelRef = useRef<HTMLAudioElement>(null);
  const mineRef = useRef<HTMLAudioElement>(null);
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef('');
  const resolveTranscriptRef = useRef<((t: string) => void) | null>(null);

  useEffect(() => { if (!loaded) refresh().catch(() => {}); }, [loaded, refresh]);

  const refreshToday = useCallback(() => {
    api<TodayTaskDto>('/stats/today').then(setToday).catch(() => {});
  }, []);
  useEffect(() => { refreshToday(); }, [refreshToday]);

  useEffect(() => {
    if (!plan) return;
    setItemsLoaded(false);
    setError('');
    // 计划 → 泛听清单（与阶段一一致：并入我的自定义材料，按 id 去重）
    Promise.all([
      apiGet<ContentItemDto[]>(`/content/items?packId=${plan.packId}&list=listening`),
      api<ContentItemDto[]>('/content/my-items?list=listening').catch(() => [] as ContentItemDto[]),
    ])
      .then(([official, mine]) => {
        const list = [...new Map([...official, ...mine].map((it) => [it.id, it])).values()];
        setItems(list);
        setItemIdx(0);
        setItemsLoaded(true);
      })
      .catch((e) => { setError(e instanceof Error ? e.message : '加载失败'); setItemsLoaded(true); });
  }, [plan, reloadKey]);

  const currentItem = items[itemIdx] ?? null;
  useEffect(() => {
    if (!currentItem) return;
    apiGet<SentenceDto[]>(`/content/items/${currentItem.id}/sentences`)
      .then((list) => { setSentences(list); setSentIdx(0); })
      .catch((e) => setError(e instanceof Error ? e.message : '加载句子失败'));
  }, [currentItem]);

  const currentSentence = sentences[sentIdx] ?? null;

  /** 跟读：高亮当前练习句 */
  useEffect(() => {
    if (mode === 'READ' && currentSentence) setActiveId(currentSentence.id);
  }, [mode, currentSentence]);

  /** 复述：整篇播放时按时间轴推进高亮（二分找最后一个 startSec <= currentTime） */
  const followTimeline = useCallback(() => {
    const el = modelAudioRef.current;
    const tl = currentItem?.timeline;
    if (!el || !tl?.length || !sentences.length) return;
    const t = el.currentTime;
    let lo = 0;
    let hi = tl.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tl[mid].startSec <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (ans < 0) return;
    const s = sentences.find((x) => x.seq === tl[ans].seq);
    if (s) setActiveId(s.id);
  }, [currentItem, sentences]);

  /** 高亮句滚动到可视区 */
  useEffect(() => {
    if (!activeId) return;
    document.querySelector<HTMLElement>(`[data-sid="${activeId}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeId]);

  const save = useCallback(async (blob: Blob, durationSec: number, transcript?: string) => {
    setSaving(true);
    setError('');
    const modelUrl = mode === SpeakingType.READ ? currentSentence?.audioUrl : currentItem?.audioUrl;
    try {
      const { url } = await uploadFile('/learning/uploads', blob);
      const body: Record<string, unknown> = { type: mode, date: todayLocal(), audioUrl: url, durationSec };
      if (mode === SpeakingType.READ) body.sentenceId = currentSentence?.id;
      else body.itemId = currentItem?.id;
      if (transcript) body.transcript = transcript;
      const rec = await api<{ id: string; score?: number; wordsFeedback?: string | null }>('/learning/speaking', {
        method: 'POST', body: JSON.stringify(body),
      });
      setSavedCount((c) => c + 1);
      const feedback = typeof rec.wordsFeedback === 'string'
        ? (JSON.parse(rec.wordsFeedback) as Array<{ word: string; ok: boolean }>)
        : null;
      setLast({ id: rec.id, url, modelUrl: modelUrl ?? '', score: rec.score, wordsFeedback: feedback });
      setRating(0);
      refreshToday();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [mode, currentSentence, currentItem, refreshToday]);

  /** D1 自评星级：写入本条录音记录 */
  const rate = useCallback(async (n: number) => {
    if (!last) return;
    setRatingBusy(true);
    setError('');
    try {
      await api(`/learning/speaking/${last.id}/rating`, {
        method: 'POST',
        body: JSON.stringify({ rating: n }),
      });
      setRating(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : '自评保存失败');
    } finally {
      setRatingBusy(false);
    }
  }, [last]);

  /** D1 对照回放：先播示范（可慢速），播完自动接我的录音 */
  const playBoth = useCallback(() => {
    const model = modelRef.current;
    const mine = mineRef.current;
    if (!model || !mine) return;
    model.currentTime = 0;
    model.playbackRate = slow ? 0.75 : 1;
    model.onended = () => { mine.currentTime = 0; void mine.play(); };
    void model.play();
  }, [slow]);

  const startRecording = useCallback(async () => {
    setError('');
    transcriptRef.current = '';
    resolveTranscriptRef.current = null;
    // 并行启动 Web Speech API（如果可用 + 跟读模式）采 transcript
    if (speechAvailable.current && mode === SpeakingType.READ) {
      try {
        const SR = getSpeechRecognition();
        if (SR) {
          const rec = new SR();
          rec.lang = 'en-US';
          rec.interimResults = true;
          rec.maxAlternatives = 1;
          rec.continuous = true;
          rec.onresult = (e: any) => {
            let text = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
              text += e.results[i][0].transcript + ' ';
            }
            transcriptRef.current = text.trim();
          };
          rec.onerror = () => { speechRef.current = null; };
          rec.onend = () => {
            if (resolveTranscriptRef.current) resolveTranscriptRef.current(transcriptRef.current);
          };
          speechRef.current = rec;
          rec.start();
        }
      } catch {
        speechRef.current = null;
      }
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        speechRef.current?.stop();
        // 等 ASR final result
        const transcript = await new Promise<string>((resolve) => {
          if (speechRef.current && transcriptRef.current.length === 0) {
            // ASR 可能还没 final，给它最多 1.5s
            resolveTranscriptRef.current = resolve;
            setTimeout(() => resolve(transcriptRef.current), 1500);
          } else {
            resolve(transcriptRef.current);
          }
        });
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        const durationSec = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
        speechRef.current = null;
        void save(blob, durationSec, transcript || undefined);
      };
      mrRef.current = mr;
      startedAtRef.current = Date.now();
      mr.start();
      setRecording(true);
    } catch {
      setMicDenied(true);
    }
  }, [save, mode]);

  const stopRecording = useCallback(() => {
    mrRef.current?.stop();
    setRecording(false);
  }, []);

  useEffect(() => () => { mrRef.current?.stop(); }, []);

  if (!loaded) return <p className="muted">加载中…</p>;
  if (!plan) {
    return (
      <div className="card">
        <h2>还没有学习计划</h2>
        <p className="muted">先创建三阶段计划，再进入口语训练。</p>
        <Link to="/onboarding"><button className="btn">创建计划</button></Link>
      </div>
    );
  }
  if (!currentItem) {
    if (!itemsLoaded) return <p className="muted">加载中…</p>;
    if (error) {
      return (
        <div className="card">
          <h2>口语材料加载失败</h2>
          <p style={{ color: '#b42318' }}>{error}</p>
          <div className="row">
            <button className="btn" onClick={() => setReloadKey((k) => k + 1)}>重试</button>
            <Link to="/materials"><button className="btn ghost">去我的材料</button></Link>
          </div>
        </div>
      );
    }
    return (
      <div className="card">
        <h2>口语清单还是空的</h2>
        <p className="muted">当前计划包没有可跟读的材料。可以在「我的材料」导入自己的内容，或到计划页更换内容包。</p>
        <div className="row">
          <Link to="/materials"><button className="btn">去我的材料</button></Link>
          <Link to="/plan"><button className="btn ghost">查看计划</button></Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h2>阶段三 · 口语输出</h2>
        <p className="muted">
          {today
            ? `今日 ${today.progress} / ${today.goal} ${({ minutes: '分钟', passages: '篇', sentences: '句' } as const)[today.unit]} · `
            : ''}
          跟读照文本朗读；复述则在无文稿下口头复述。
        </p>
        <div className="row">
          <button className={mode === 'READ' ? 'btn' : 'btn ghost'} onClick={() => { setMode('READ'); setSavedCount(0); setLast(null); setRating(0); }}>跟读</button>
          <button className={mode === 'RETELL' ? 'btn' : 'btn ghost'} onClick={() => { setMode('RETELL'); setSavedCount(0); setLast(null); setRating(0); }}>复述</button>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          想换种方式练？<Link to="/dialogue">AI 情景对话</Link>：在真实生活场景里一来一往地开口。
        </p>
      </div>

      {error && <p style={{ color: '#b42318' }}>{error}</p>}

      <div className="card">
        <h2>{currentItem.title}</h2>
        {mode === 'READ' && currentSentence ? (
          <>
            <p className="muted">第 {sentIdx + 1} / {sentences.length} 句 · 照文本朗读</p>
            <div style={{ margin: '8px 0', fontSize: 16 }}>{currentSentence.text}</div>
            <div className="muted">{currentSentence.translation}</div>
            <AudioWithOffline src={currentSentence.audioUrl} style={{ marginTop: 8 }} />
          </>
        ) : mode === 'READ' ? (
          <p className="muted">这篇材料还没有可跟读的句子切片，可切到「复述」模式练整篇。</p>
        ) : (
          <>
            <p className="muted">复述：先听整篇（无文稿），再口头复述大意。</p>
            <AudioWithOffline
              src={currentItem.audioUrl}
              elRef={modelAudioRef}
              onTimeUpdate={followTimeline}
            />
            <div className="row">
              <button className="btn ghost" onClick={() => setShowScript((v) => !v)}>
                {showScript ? '隐藏文稿' : '显示文稿（跟随播放高亮）'}
              </button>
            </div>
          </>
        )}

        {micDenied ? (
          <p style={{ color: '#b42318' }}>
            麦克风不可用：请在浏览器地址栏权限中允许「麦克风」后刷新页面重试。
          </p>
        ) : (
          <div className="row">
            {!recording ? (
              <button className="btn" disabled={saving} onClick={startRecording}>开始录音</button>
            ) : (
              <button className="btn" onClick={stopRecording}>停止并保存</button>
            )}
            {mode === 'READ' && currentSentence && sentIdx + 1 < sentences.length && (
              <button className="btn ghost" disabled={recording} onClick={() => { setSentIdx((i) => i + 1); setLast(null); setRating(0); }}>下一句</button>
            )}
          </div>
        )}

        {saving && <p className="muted">上传中…</p>}
        {last && (
          <div style={{ marginTop: 12 }}>
            <p className="muted">已保存 · 本次共 {savedCount} 段 · 对照回放：先听示范，再听自己</p>
            {typeof last.score === 'number' && (
              <div style={{ marginTop: 8, padding: '8px 12px', background: '#f6f8fa', borderRadius: 8 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: last.score >= 80 ? '#2e7d32' : last.score >= 60 ? '#ed6c02' : '#c62828' }}>
                  {last.score} 分
                </span>
                <span className="muted" style={{ marginLeft: 8 }}>
                  {last.score >= 90 ? '优秀' : last.score >= 80 ? '很好' : last.score >= 60 ? '继续加油' : '多练几遍'}
                </span>
                {last.wordsFeedback && last.wordsFeedback.length > 0 && (
                  <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {last.wordsFeedback.map((w, i) => (
                      <span
                        key={i}
                        style={{
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: w.ok ? '#e8f5e9' : '#ffebee',
                          color: w.ok ? '#2e7d32' : '#c62828',
                          fontSize: 14,
                        }}
                      >
                        {w.word}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div style={{ marginTop: 6 }}><b>示范</b></div>
            <audio ref={modelRef} src={last.modelUrl} controls style={{ width: '100%' }} />
            <div style={{ marginTop: 6 }}><b>我的录音</b></div>
            <audio ref={mineRef} src={last.url} controls style={{ width: '100%' }} />
            <div className="row" style={{ marginTop: 8, alignItems: 'center' }}>
              <button className="btn" onClick={playBoth}>示范 → 我的（连续对照）</button>
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} />
                示范慢速 0.75×
              </label>
            </div>
            <div className="row" style={{ marginTop: 8, alignItems: 'center' }}>
              <span className="muted">自评：</span>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className={n <= rating ? 'btn' : 'btn ghost'}
                  style={{ padding: '2px 10px', fontSize: 16 }}
                  disabled={ratingBusy}
                  onClick={() => void rate(n)}
                >
                  ★
                </button>
              ))}
              {rating > 0 && <span className="muted">{rating} 星已记录</span>}
            </div>
          </div>
        )}
      </div>

      {(mode === 'READ' || showScript) && sentences.length > 0 && (
        <div className="card">
          <h2>逐句列表 · {mode === 'READ' ? '点击跳句' : '跟随播放高亮'}</h2>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {sentences.map((s, i) => {
              const active = activeId === s.id;
              return (
                <div
                  key={s.id}
                  data-sid={s.id}
                  data-active={active ? '1' : undefined}
                  onClick={() => {
                    if (mode === 'READ') { setSentIdx(i); setLast(null); setRating(0); }
                  }}
                  style={{
                    padding: '6px 8px',
                    borderRadius: 6,
                    cursor: mode === 'READ' ? 'pointer' : 'default',
                    background: active ? '#e8f0fe' : undefined,
                    borderLeft: active ? '3px solid #1a73e8' : '3px solid transparent',
                    fontSize: 14,
                    marginBottom: 2,
                  }}
                >
                  <span className="muted">{s.seq}. </span>
                  {s.text}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
