import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FavoriteSentenceDto, WrongWordDto, WrongWordDueDto } from '@ladder/shared';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { AudioWithOffline } from '../../components/AudioWithOffline';

/** 没听懂的句子条目（与后端 GET /learning/confused 出参一致） */
interface ConfusedEntry {
  id: string;
  createdAt: string;
  sentence: {
    id: string;
    text: string;
    translation: string;
    audioUrl: string;
    item: { id: string; title: string };
  };
}

/** SRS 毕业所需连续「记住了」次数（与后端 SRS_MASTER_REVIEWS 一致） */
const MASTER_REVIEWS = 4;

/** I1 近 7 天复习趋势（与 GET /learning/review-stats 出参一致） */
interface ReviewStatsDay {
  date: string;
  total: number;
  remembered: number;
  rate: number;
}
interface ReviewStatsDto {
  days: ReviewStatsDay[];
  total: number;
  remembered: number;
  rate: number;
}

/** 到期日与今天的整天差（负 = 逾期） */
function dayDiff(iso: string): number {
  const d = new Date(iso);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today.getTime()) / 86400000);
}

function dueLabel(w: WrongWordDto): string {
  const n = dayDiff(w.dueAt);
  if (n < 0) return `逾期 ${-n} 天`;
  if (n === 0) return '今天到期';
  return `${n} 天后`;
}

/** F1 本地日期 YYYY-MM-DD（用于按出错日期筛选） */
function localDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** F1/H1 下载 CSV：fetch 取 Blob 以保留登录态 */
async function downloadCsv(path: string, filename: string, token: string | null): Promise<void> {
  const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`导出失败（${res.status}）`);
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** F1 单词音标：模块级缓存，同一单词只请求一次；无结果显示时静默不渲染 */
const phoneticCache = new Map<string, string | null>();

function Phonetic({ word }: { word: string }) {
  const [text, setText] = useState<string | null>(phoneticCache.get(word.toLowerCase()) ?? null);
  useEffect(() => {
    const key = word.toLowerCase();
    if (phoneticCache.has(key)) {
      setText(phoneticCache.get(key) ?? null);
      return;
    }
    let alive = true;
    api<{ phonetic: string | null }>(`/content/word-info?word=${encodeURIComponent(word)}`)
      .then((res) => {
        phoneticCache.set(key, res.phonetic ?? null);
        if (alive) setText(res.phonetic ?? null);
      })
      .catch(() => {
        phoneticCache.set(key, null);
        if (alive) setText(null);
      });
    return () => { alive = false; };
  }, [word]);
  if (!text) return null;
  return <span className="muted" style={{ fontSize: 13 }}>{text}</span>;
}

/** F1 单词发音：首次点击时按需合成，之后直接播放缓存 */
function WordAudio({ word }: { word: string }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLAudioElement | null>(null);

  const play = async () => {
    setError('');
    if (url) {
      if (ref.current) { ref.current.currentTime = 0; void ref.current.play(); }
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ url: string }>(`/content/word-audio?word=${encodeURIComponent(word)}`);
      setUrl(res.url);
      requestAnimationFrame(() => { void ref.current?.play(); });
    } catch (e) {
      setError(e instanceof Error ? e.message : '发音加载失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }} disabled={loading} onClick={() => void play()}>
        {loading ? '合成中…' : '听单词'}
      </button>
      {url && <audio ref={ref} src={url} preload="auto" style={{ display: 'none' }} />}
      {error && <span className="muted" style={{ fontSize: 12 }}>{error}</span>}
    </>
  );
}

/** F1 单词跟读：录音后本地回放对照（不上传，不产生服务端记录） */
function WordShadow() {
  const [recording, setRecording] = useState(false);
  const [clip, setClip] = useState('');
  const [denied, setDenied] = useState(false);
  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => () => { if (clip) URL.revokeObjectURL(clip); }, [clip]);
  useEffect(() => () => { mrRef.current?.stop(); }, []);

  const start = async () => {
    setDenied(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setClip(URL.createObjectURL(new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })));
      };
      mrRef.current = mr;
      mr.start();
      setRecording(true);
    } catch {
      setDenied(true);
    }
  };

  const stop = () => { mrRef.current?.stop(); setRecording(false); };

  return (
    <div>
      <div className="row" style={{ gap: 8 }}>
        <button className={recording ? 'btn' : 'btn ghost'} style={{ padding: '4px 12px', fontSize: 13 }} onClick={() => (recording ? stop() : void start())}>
          {recording ? '停止跟读' : '跟读录音'}
        </button>
        {clip && <audio src={clip} controls style={{ height: 32 }} />}
      </div>
      {denied && <p className="muted" style={{ fontSize: 12 }}>麦克风不可用，请在浏览器权限中允许后重试。</p>}
    </div>
  );
}

type View = 'list' | 'review';

/**
 * P1 错词本复习 + A2 间隔重复（SRS）。
 * 列表视图：到期队列（按到期时间升序）、学习中、没听懂队列。
 * 复习视图：逐条「听原句 → 默写 → 对照 → 记住了 / 再练一次」，
 * 记住按 1/3/7 天递进，连续 4 次毕业；再练一次归零并回到本轮队尾。
 */
export function ReviewPage() {
  const token = useAuthStore((s) => s.token);
  const [data, setData] = useState<WrongWordDueDto | null>(null);
  const [confused, setConfused] = useState<ConfusedEntry[]>([]);
  const [favorites, setFavorites] = useState<FavoriteSentenceDto[]>([]);
  const [words, setWords] = useState<WrongWordDto[]>([]);
  const [reviewStats, setReviewStats] = useState<ReviewStatsDto | null>(null);
  const [view, setView] = useState<View>('list');
  const [queue, setQueue] = useState<WrongWordDto[]>([]);
  const [input, setInput] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // F2 筛选与批量操作
  const [filterItem, setFilterItem] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  // F3 复习日历：选中的日期（'overdue' = 逾期汇总）
  const [calDay, setCalDay] = useState<string | null>(null);
  // H3 本轮复习小结
  const [session, setSession] = useState<{ reviewed: number; forgot: number; mastered: number } | null>(null);
  // J2 收藏句检索：关键词 + 材料筛选（客户端过滤）
  const [favQuery, setFavQuery] = useState('');
  const [favItem, setFavItem] = useState('');
  // K2 没听懂批量处理
  const [confusedSelected, setConfusedSelected] = useState<Set<string>>(new Set());
  const [confusedBusy, setConfusedBusy] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) { setLoading(true); setError(''); }
    try {
      const [due, marks, favs, all, rv] = await Promise.all([
        api<WrongWordDueDto>('/learning/wrong-words/due'),
        api<ConfusedEntry[]>('/learning/confused'),
        api<FavoriteSentenceDto[]>('/learning/favorites').catch(() => [] as FavoriteSentenceDto[]),
        api<WrongWordDto[]>('/learning/wrong-words'),
        api<ReviewStatsDto>('/learning/review-stats?days=7').catch(() => null),
      ]);
      setData(due);
      setConfused(marks);
      setFavorites(favs);
      setWords(all);
      setReviewStats(rv);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);
  useEffect(() => { if (token) void load(); }, [token, load]);

  const stats = data?.stats;
  const current = queue[0] ?? null;

  const markMastered = useCallback(async (id: string) => {
    try {
      await api(`/learning/wrong-words/${id}/mastered`, { method: 'POST' });
      setData((d) => {
        if (!d) return d;
        return {
          ...d,
          due: d.due.filter((w) => w.id !== id),
          upcoming: d.upcoming.filter((w) => w.id !== id),
          stats: { ...d.stats, mastered: d.stats.mastered + 1 },
        };
      });
      setQueue((q) => q.filter((w) => w.id !== id));
      setWords((ws) => ws.filter((w) => w.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    }
  }, []);

  /** F2 批量标记已掌握 / 批量删除 */
  const batch = useCallback(async (action: 'mastered' | 'delete') => {
    if (!selected.size) return;
    if (action === 'delete' && !window.confirm(`确定删除选中的 ${selected.size} 个错词？删除后不可恢复。`)) return;
    setBusy(action); setError('');
    try {
      await api('/learning/wrong-words/batch', {
        method: 'POST',
        body: JSON.stringify({ ids: [...selected], action }),
      });
      setSelected(new Set());
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy('');
    }
  }, [selected, load]);

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const today = new Date().toISOString().slice(0, 10);

  /** F1 收藏句导出为 Anki CSV */
  const exportAnki = useCallback(async () => {
    setBusy('anki'); setError('');
    try {
      await downloadCsv('/stats/export/csv?entity=favorites', `ladder-anki-${today}.csv`, token);
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
    } finally {
      setBusy('');
    }
  }, [token, today]);

  /** H1 按当前筛选条件导出错词为 Anki CSV */
  const exportWrongWords = useCallback(async () => {
    const params = new URLSearchParams({ entity: 'wrong-words-anki' });
    if (filterItem) params.set('itemId', filterItem);
    if (filterFrom) params.set('from', filterFrom);
    if (filterTo) params.set('to', filterTo);
    setBusy('wrong-anki'); setError('');
    try {
      await downloadCsv(`/stats/export/csv?${params.toString()}`, `ladder-wrong-words-anki-${today}.csv`, token);
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
    } finally {
      setBusy('');
    }
  }, [token, today, filterItem, filterFrom, filterTo]);

  /** F2 取消收藏（在错词本页维护收藏夹） */
  const removeFavorite = useCallback(async (sentenceId: string) => {
    try {
      await api(`/learning/favorites/${sentenceId}`, { method: 'DELETE' });
      setFavorites((fs) => fs.filter((f) => f.sentence.id !== sentenceId));
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    }
  }, []);

  const resolveConfused = useCallback(async (id: string) => {
    try {
      await api(`/learning/confused/${id}/resolved`, { method: 'POST' });
      setConfused((cs) => cs.filter((c) => c.id !== id));
      setConfusedSelected((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    }
  }, []);

  /** K2 批量标记已听懂：一次请求处理，成功后本地移除并清空勾选 */
  const resolveConfusedBatch = useCallback(async () => {
    if (!confusedSelected.size) return;
    setConfusedBusy(true); setError('');
    try {
      await api('/learning/confused/batch-resolved', {
        method: 'POST',
        body: JSON.stringify({ ids: [...confusedSelected] }),
      });
      setConfused((cs) => cs.filter((c) => !confusedSelected.has(c.id)));
      setConfusedSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setConfusedBusy(false);
    }
  }, [confusedSelected]);

  const toggleConfusedOne = useCallback((id: string) => {
    setConfusedSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleConfusedAll = useCallback(() => {
    const ids = confused.map((c) => c.id);
    setConfusedSelected((prev) => {
      const next = new Set(prev);
      if (ids.length && ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, [confused]);

  /** 复习反馈：写入 SRS，并同步本地队列/统计 */
  const review = useCallback(async (remembered: boolean) => {
    const word = queue[0];
    if (!word) return;
    setError('');
    try {
      await api(`/learning/wrong-words/${word.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ remembered }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
      return;
    }
    setInput(''); setRevealed(false);

    // I1 本地同步近 7 天趋势，避免每次复习后重新拉取整页
    const dayKey = localDate(new Date().toISOString());
    setReviewStats((s) => {
      if (!s) return s;
      const days = s.days.map((d) => {
        if (d.date !== dayKey) return d;
        const total = d.total + 1;
        const kept = d.remembered + (remembered ? 1 : 0);
        return { ...d, total, remembered: kept, rate: total ? kept / total : 0 };
      });
      const total = s.total + 1;
      const kept = s.remembered + (remembered ? 1 : 0);
      return { ...s, days, total, remembered: kept, rate: total ? kept / total : 0 };
    });

    if (!remembered) {
      setSession((s) => (s ? { ...s, forgot: s.forgot + 1 } : s));
      // 再练一次：归零并挪到本轮队尾，稍后再过一遍
      const dueAt = new Date().toISOString();
      setQueue((q) => (q.length > 1 ? [...q.slice(1), { ...word, reviewCount: 0, dueAt }] : q));
      setWords((ws) => ws.map((w) => (w.id === word.id ? { ...w, reviewCount: 0, dueAt } : w)));
      return;
    }

    const next = word.reviewCount + 1;
    const mastered = next >= MASTER_REVIEWS;
    // H2 允许从日历提前复习未到期词：需区分原本是否在到期队列中
    const now = Date.now();
    const wasDue = new Date(word.dueAt).getTime() <= now;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const wasOverdue = wasDue && new Date(word.dueAt) < startOfToday;
    const dueAt = new Date(now + [1, 3, 7][next - 1] * 86400000).toISOString();
    setSession((s) => (s ? { ...s, reviewed: s.reviewed + 1, mastered: s.mastered + (mastered ? 1 : 0) } : s));
    setQueue((q) => q.slice(1));
    // 同步本地错词列表，让日历/逾期计数即时更新（毕业词从列表移除）
    setWords((ws) => (mastered
      ? ws.filter((w) => w.id !== word.id)
      : ws.map((w) => (w.id === word.id ? { ...w, reviewCount: next, dueAt } : w))));
    setData((d) => {
      if (!d) return d;
      const rest = d.upcoming.filter((w) => w.id !== word.id);
      return {
        ...d,
        due: wasDue ? d.due.filter((w) => w.id !== word.id) : d.due,
        upcoming: mastered ? rest : [...rest, { ...word, reviewCount: next, dueAt }],
        stats: {
          ...d.stats,
          due: wasDue ? Math.max(0, d.stats.due - 1) : d.stats.due,
          overdue: wasOverdue ? Math.max(0, d.stats.overdue - 1) : d.stats.overdue,
          learning: wasDue
            ? (mastered ? d.stats.learning : d.stats.learning + 1)
            : (mastered ? Math.max(0, d.stats.learning - 1) : d.stats.learning),
          mastered: mastered ? d.stats.mastered + 1 : d.stats.mastered,
        },
      };
    });
  }, [queue]);

  /** 从指定词表开始一轮复习（到期队列 / 日历某天 / 逾期汇总） */
  const startReviewWith = useCallback((list: WrongWordDto[]) => {
    setQueue(list);
    setSession({ reviewed: 0, forgot: 0, mastered: 0 });
    setInput(''); setRevealed(false); setView('review');
  }, []);

  const startReview = useCallback(() => startReviewWith(data?.due ?? []), [data, startReviewWith]);

  /** F2 材料下拉：从全部错词中提取去重后的材料 */
  const materials = useMemo(() => {
    const map = new Map<string, string>();
    words.forEach((w) => map.set(w.sentence.item.id, w.sentence.item.title));
    return [...map.entries()];
  }, [words]);

  /** F2 筛选：材料 + 首次出错日期区间（本地日期） */
  const filteredWords = useMemo(() => words.filter((w) => {
    if (filterItem && w.sentence.item.id !== filterItem) return false;
    const day = localDate(w.createdAt);
    if (filterFrom && day < filterFrom) return false;
    if (filterTo && day > filterTo) return false;
    return true;
  }), [words, filterItem, filterFrom, filterTo]);

  const allSelected = filteredWords.length > 0 && filteredWords.every((w) => selected.has(w.id));

  const toggleAll = useCallback(() => {
    const ids = filteredWords.map((w) => w.id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, [filteredWords]);

  const clearFilters = useCallback(() => {
    setFilterItem(''); setFilterFrom(''); setFilterTo(''); setSelected(new Set());
  }, []);

  /** F3 复习日历：未来 14 天按到期日聚合（逾期单独汇总） */
  const calendar = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return {
        date,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        weekday: '日一二三四五六'[d.getDay()],
        words: [] as WrongWordDto[],
      };
    });
    const overdue: WrongWordDto[] = [];
    let later = 0;
    words.forEach((w) => {
      const n = dayDiff(w.dueAt);
      if (n < 0) overdue.push(w);
      else if (n < days.length) days[n].words.push(w);
      else later += 1;
    });
    return { days, overdue, later };
  }, [words]);

  const calWords = useMemo(() => {
    if (!calDay) return [];
    if (calDay === 'overdue') return calendar.overdue;
    return calendar.days.find((d) => d.date === calDay)?.words ?? [];
  }, [calDay, calendar]);

  /** I1 趋势柱状图基准：近 7 天单日最大复习次数 */
  const maxReview = Math.max(1, ...(reviewStats?.days.map((d) => d.total) ?? [0]));

  /** J2 收藏句材料下拉 + 关键词/材料过滤 */
  const favMaterials = useMemo(() => {
    const map = new Map<string, string>();
    favorites.forEach((f) => map.set(f.sentence.item.id, f.sentence.item.title));
    return [...map.entries()];
  }, [favorites]);

  const filteredFavorites = useMemo(() => {
    const q = favQuery.trim().toLowerCase();
    return favorites.filter((f) => {
      if (favItem && f.sentence.item.id !== favItem) return false;
      if (!q) return true;
      return f.sentence.text.toLowerCase().includes(q)
        || f.sentence.translation.toLowerCase().includes(q)
        || f.sentence.item.title.toLowerCase().includes(q);
    });
  }, [favorites, favQuery, favItem]);

  if (loading) return <p className="muted">加载中…</p>;

  /* ---------- 复习视图 ---------- */
  if (view === 'review') {
    if (!current) {
      return (
        <div className="card">
          <h2>本轮复习完成</h2>
          {session && (session.reviewed > 0 || session.forgot > 0) ? (
            <p className="muted">
              本轮记住 {session.reviewed} 次、再练 {session.forgot} 次
              {session.mastered > 0 && `，${session.mastered} 个词已毕业`}。
              当前仍有 {data?.stats.due ?? 0} 个词待到复习。
            </p>
          ) : (
            <p className="muted">今日到期错词已全部过完，下一批将在到期日自动出现在这里。</p>
          )}
          <div className="row">
            <button className="btn" onClick={() => setView('list')}>返回列表</button>
            <button className="btn ghost" onClick={() => { void load(); setView('list'); }}>刷新</button>
          </div>
        </div>
      );
    }
    return (
      <div>
        <div className="card">
          <h2>错词复习 · 剩余 {queue.length} 个</h2>
          <p className="muted">
            先听原句，默写包含错词的整句或该词，再对照。
            {current.reviewCount > 0 && ` 已连续记住 ${current.reviewCount} / ${MASTER_REVIEWS} 次`}
          </p>
          <AudioWithOffline src={current.sentence.audioUrl} />
          <div style={{ margin: '12px 0' }}>
            <input
              type="text"
              placeholder="默写后回车对照"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setRevealed(true); }}
            />
          </div>
          {!revealed ? (
            <div className="row">
              <button className="btn" onClick={() => setRevealed(true)}>对照答案</button>
            </div>
          ) : (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 15 }}>
                错词：<b style={{ color: '#b42318' }}>{current.word}</b>
              </div>
              <div style={{ margin: '6px 0' }}>{current.sentence.text}</div>
              <div className="muted">{current.sentence.translation}</div>
              <div className="row" style={{ marginTop: 10, gap: 10, flexWrap: 'wrap' }}>
                <WordAudio word={current.word} />
                <WordShadow />
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn" onClick={() => void review(true)}>记住了</button>
                <button className="btn ghost" onClick={() => void review(false)}>再练一次</button>
              </div>
            </div>
          )}
          {error && <p style={{ color: '#b42318' }}>{error}</p>}
        </div>
      </div>
    );
  }

  /* ---------- 列表视图 ---------- */
  return (
    <div>
      <div className="card">
        <h2>错词本</h2>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="tag warn">待复习 {stats?.due ?? 0}</span>
          {(stats?.overdue ?? 0) > 0 && <span className="tag warn">逾期 {stats?.overdue}</span>}
          <span className="tag">学习中 {stats?.learning ?? 0}</span>
          <span className="tag">已掌握 {stats?.mastered ?? 0}</span>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          听写写错的词自动进入错词本，按 1 / 3 / 7 天间隔重复；连续记住 {MASTER_REVIEWS} 次即毕业。
          另有 {confused.length} 句没听懂（来自听力标记）。
        </p>
        {(stats?.due ?? 0) > 0 && (
          <div className="row">
            <button className="btn" onClick={startReview}>开始复习（{stats?.due}）</button>
          </div>
        )}
        {error && (
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <p style={{ color: '#b42318', margin: 0 }}>{error}</p>
            <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }} onClick={() => void load()}>
              重试
            </button>
          </div>
        )}
      </div>

      {/* I1 近 7 天复习趋势：次数柱状 + 记住率 */}
      {reviewStats && (
        <div className="card">
          <h2>近 7 天复习</h2>
          <p className="muted">
            共复习 {reviewStats.total} 次 · 记住率 {reviewStats.total ? Math.round(reviewStats.rate * 100) : 0}%
            {reviewStats.total === 0 && '（完成一轮复习后会在这里显示趋势）'}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
            {reviewStats.days.map((d) => (
              <div key={d.date} style={{ textAlign: 'center' }}>
                <div style={{ height: 48, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                  <div
                    title={`${d.date}：${d.total} 次`}
                    style={{
                      width: '60%',
                      height: `${Math.max(d.total ? 8 : 2, Math.round((d.total / maxReview) * 100))}%`,
                      background: d.total ? '#f79009' : '#eef1f6',
                      borderRadius: 4,
                    }}
                  />
                </div>
                <div className="muted" style={{ fontSize: 11 }}>{d.date.slice(5)}</div>
                <div className="muted" style={{ fontSize: 11 }}>{d.total}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* F3 复习日历：未来 14 天到期数量，点击某天查看具体单词 */}
      <div className="card">
        <h2>复习日历（未来 14 天）</h2>
        <p className="muted">按到期日汇总待复习错词，点击某天查看具体单词。</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <button
            className={`btn ${calDay === 'overdue' ? '' : 'ghost'}`}
            style={{ padding: '4px 12px', fontSize: 13 }}
            disabled={!calendar.overdue.length}
            onClick={() => setCalDay(calDay === 'overdue' ? null : 'overdue')}
          >
            逾期 {calendar.overdue.length}
          </button>
          {calendar.later > 0 && (
            <span className="muted" style={{ fontSize: 12 }}>另有 {calendar.later} 个将在 14 天后到期</span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
          {calendar.days.map((d) => (
            <button
              key={d.date}
              className="btn ghost"
              style={{
                padding: '6px 2px', display: 'flex', flexDirection: 'column', gap: 2,
                borderColor: calDay === d.date ? '#f79009' : undefined,
                background: calDay === d.date ? '#fff7ed' : undefined,
              }}
              onClick={() => setCalDay(calDay === d.date ? null : d.date)}
            >
              <span className="muted" style={{ fontSize: 11 }}>{d.label} 周{d.weekday}</span>
              <span style={{ fontSize: 15, fontWeight: 600, color: d.words.length ? '#b42318' : undefined }}>
                {d.words.length}
              </span>
            </button>
          ))}
        </div>
        {calDay && (
          <div style={{ marginTop: 10 }}>
            <p style={{ margin: 0 }}>
              <b>{calDay === 'overdue' ? '已逾期' : calDay}</b>：
              {calWords.length ? calWords.map((w) => w.word).join(' · ') : '没有到期错词'}
            </p>
            {calWords.length > 0 && (
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn" onClick={() => startReviewWith(calWords)}>
                  开始复习这 {calWords.length} 个词
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* F2 错词筛选 + 批量操作 */}
      {words.length > 0 && (
        <div className="card">
          <h2>全部错词（{filteredWords.length}）</h2>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              value={filterItem}
              onChange={(e) => { setFilterItem(e.target.value); setSelected(new Set()); }}
              style={{ maxWidth: 220 }}
            >
              <option value="">全部材料</option>
              {materials.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
            </select>
            <input
              type="date" value={filterFrom} style={{ width: 150 }}
              onChange={(e) => { setFilterFrom(e.target.value); setSelected(new Set()); }}
            />
            <span className="muted">至</span>
            <input
              type="date" value={filterTo} style={{ width: 150 }}
              onChange={(e) => { setFilterTo(e.target.value); setSelected(new Set()); }}
            />
            {(filterItem || filterFrom || filterTo) && (
              <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }} onClick={clearFilters}>
                清除筛选
              </button>
            )}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
            <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }} onClick={toggleAll}>
              {allSelected ? '取消全选' : '全选当前'}
            </button>
            <span className="muted" style={{ fontSize: 13 }}>已选 {selected.size}</span>
            <button className="btn" disabled={!selected.size || !!busy} onClick={() => void batch('mastered')}>
              {busy === 'mastered' ? '处理中…' : '批量标记已掌握'}
            </button>
            <button className="btn ghost" disabled={!selected.size || !!busy} onClick={() => void batch('delete')}>
              {busy === 'delete' ? '处理中…' : '批量删除'}
            </button>
            <button
              className="btn ghost"
              disabled={!!busy || !filteredWords.length}
              onClick={() => void exportWrongWords()}
            >
              {busy === 'wrong-anki' ? '导出中…' : '导出筛选结果（Anki CSV）'}
            </button>
          </div>
        </div>
      )}

      {words.length === 0 && !error && (
        <div className="card">
          <p className="muted">
            错词本是空的。去 <Link to="/dictation">听写</Link> 里练一练，写错的词会自动进到这里。
          </p>
        </div>
      )}
      {words.length > 0 && filteredWords.length === 0 && (
        <div className="card">
          <p className="muted">当前筛选条件下没有错词。</p>
        </div>
      )}

      {filteredWords.map((w) => (
        <div className="card" key={w.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox" checked={selected.has(w.id)} style={{ width: 18, height: 18 }}
                onChange={() => toggleOne(w.id)}
              />
              <b style={{ color: '#b42318', fontSize: 16 }}>{w.word}</b>
              <Phonetic word={w.word} />
              <span className={`tag ${dayDiff(w.dueAt) < 0 ? 'warn' : ''}`}>{dueLabel(w)}</span>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <WordAudio word={w.word} />
              <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }} onClick={() => markMastered(w.id)}>
                标记已掌握
              </button>
            </div>
          </div>
          <div style={{ margin: '6px 0' }}>{w.sentence.text}</div>
          <div className="muted">{w.sentence.translation}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            来自《{w.sentence.item.title}》 · 首次出错 {localDate(w.createdAt)}
          </div>
          <AudioWithOffline src={w.sentence.audioUrl} />
        </div>
      ))}

      {/* F2 收藏夹：听力/听写中收藏的句子，集中回听；J2 支持关键词与材料筛选 */}
      {favorites.length > 0 && (
        <div className="card">
          <h2>收藏的句子（{filteredFavorites.length}/{favorites.length}）</h2>
          <p className="muted">来自听力与听写训练，集中回听；可在听力/听写页重新取消收藏。</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              value={favQuery}
              onChange={(e) => setFavQuery(e.target.value)}
              placeholder="搜索句子或翻译关键词"
              style={{ maxWidth: 240 }}
            />
            <select value={favItem} onChange={(e) => setFavItem(e.target.value)} style={{ maxWidth: 220 }}>
              <option value="">全部材料</option>
              {favMaterials.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
            </select>
            {(favQuery || favItem) && (
              <button
                className="btn ghost"
                style={{ padding: '4px 12px', fontSize: 13 }}
                onClick={() => { setFavQuery(''); setFavItem(''); }}
              >
                清除筛选
              </button>
            )}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn ghost" disabled={!!busy} onClick={() => void exportAnki()}>
              {busy === 'anki' ? '导出中…' : '导出 Anki CSV'}
            </button>
          </div>
        </div>
      )}
      {favorites.length > 0 && filteredFavorites.length === 0 && (
        <div className="card">
          <p className="muted">当前筛选条件下没有收藏句。</p>
        </div>
      )}
      {filteredFavorites.map((f) => (
        <div className="card" key={f.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>来自《{f.sentence.item.title}》</b>
            <button
              className="btn ghost"
              style={{ padding: '4px 12px', fontSize: 13 }}
              onClick={() => void removeFavorite(f.sentence.id)}
            >
              取消收藏
            </button>
          </div>
          <div style={{ margin: '6px 0' }}>{f.sentence.text}</div>
          <div className="muted">{f.sentence.translation}</div>
          <AudioWithOffline src={f.sentence.audioUrl} />
        </div>
      ))}

      {/* P1「没听懂」队列：听力中标记的句子，回听对照后移出；K2 支持勾选批量处理 */}
      {confused.length > 0 && (
        <div className="card">
          <h2>没听懂的句子（{confused.length}）</h2>
          <p className="muted">听力中标记的句子，回听并对照翻译后点「已听懂」即可移出；也可勾选后批量处理。</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }} onClick={toggleConfusedAll}>
              {confused.every((c) => confusedSelected.has(c.id)) ? '取消全选' : '全选'}
            </button>
            <span className="muted" style={{ fontSize: 13 }}>已选 {confusedSelected.size}</span>
            <button className="btn" disabled={!confusedSelected.size || confusedBusy} onClick={() => void resolveConfusedBatch()}>
              {confusedBusy ? '处理中…' : '批量标记已听懂'}
            </button>
          </div>
        </div>
      )}

      {confused.map((c) => (
        <div className="card" key={c.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={confusedSelected.has(c.id)}
                style={{ width: 18, height: 18 }}
                onChange={() => toggleConfusedOne(c.id)}
              />
              <b>来自《{c.sentence.item.title}》</b>
            </div>
            <button
              className="btn ghost"
              style={{ padding: '4px 12px', fontSize: 13 }}
              onClick={() => resolveConfused(c.id)}
            >
              已听懂
            </button>
          </div>
          <div style={{ margin: '6px 0' }}>{c.sentence.text}</div>
          <div className="muted">{c.sentence.translation}</div>
          <AudioWithOffline src={c.sentence.audioUrl} />
        </div>
      ))}
    </div>
  );
}
