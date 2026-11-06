import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { GradingMode, REPLAY_HINT_THRESHOLD } from '@ladder/shared';
import type { ContentItemDto, ContentSearchDto, DictationPriorityDto, SentenceDto, TodayTaskDto } from '@ladder/shared';
import { api } from '../../api/client';
import { usePlanStore } from '../../stores/plan';
import { gradeDictation } from '../../lib/dictationGrader';
import type { GradeResult, WordMark } from '../../lib/dictationGrader';
import { todayLocal } from '../../lib/date';
import { apiGet } from '../../lib/offline';
import { AudioWithOffline } from '../../components/AudioWithOffline';

type Phase = 'prelisten' | 'work' | 'done';

/** K1 本篇小结：本次提交的逐句结果（用于统计与错句重练） */
interface SentenceResult {
  sentenceId: string;
  text: string;
  correctRate: number;
  wrongWords: string[];
}

/** 词级标注渲染：正确(绿) / 拼错(红 删除线+正确词) / 漏词(红 下划线) / 多词(灰 删除线) */
function Mark({ m }: { m: WordMark }) {
  if (m.kind === 'ok') return <span style={{ color: '#067647', marginRight: 4 }}>{m.word}</span>;
  if (m.kind === 'wrong') {
    return (
      <span style={{ marginRight: 4 }}>
        <span style={{ color: '#b42318', textDecoration: 'line-through' }}>{m.input}</span>{' '}
        <b style={{ color: '#067647' }}>{m.expected}</b>
      </span>
    );
  }
  if (m.kind === 'missing') {
    return <span style={{ color: '#b42318', textDecoration: 'underline', marginRight: 4 }}>{m.expected}</span>;
  }
  return <span className="muted" style={{ textDecoration: 'line-through', marginRight: 4 }}>{m.input}</span>;
}

/**
 * FR-04 阶段二 · 逐句听写。
 * 整篇预听 1 遍 → 逐句：播放 → 键入 → gradeDictation 词级批改 → 结果 POST /learning/dictation（错词入库）。
 * 宽容/严格模式切换；回听次数记录，超阈值给出「太难了？」提示。
 */
export function DictationPage() {
  const { plan, loaded, refresh } = usePlanStore();

  const [items, setItems] = useState<ContentItemDto[]>([]);
  const [itemsLoaded, setItemsLoaded] = useState(false);
  /** 清单加载失败后的重试计数 */
  const [reloadKey, setReloadKey] = useState(0);
  const [itemIdx, setItemIdx] = useState(0);
  const [sentences, setSentences] = useState<SentenceDto[]>([]);
  const [sentIdx, setSentIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>('prelisten');
  const [input, setInput] = useState('');
  const [result, setResult] = useState<GradeResult | null>(null);
  const [listenCount, setListenCount] = useState(0);
  const [mode, setMode] = useState<GradingMode>(GradingMode.LENIENT);
  const [today, setToday] = useState<TodayTaskDto | null>(null);
  const [error, setError] = useState('');
  /** P2-2：没听懂优先队列（未 resolved 且当日未听写），用于材料/句子排序与优先标记 */
  const [priority, setPriority] = useState<DictationPriorityDto>({ sentenceIds: [], itemIds: [] });
  /** F2 句子收藏：已收藏句子 id 集合 */
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  /** J1 内容搜索：关键词、结果与加载态；pendingSentence 用于跨材料定位到具体句子 */
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<ContentSearchDto | null>(null);
  const [searching, setSearching] = useState(false);
  const pendingSentence = useRef('');
  /** 优先句排序基准：与 priority 同步写入 ref，避免提交后 priority 变更触发句子重载 */
  const priorityIdsRef = useRef<string[]>([]);
  /** K1 本次提交逐句结果 + 本篇完整句序（错句重练时需保留全量以便「再练一遍」） */
  const [results, setResults] = useState<SentenceResult[]>([]);
  const fullSentences = useRef<SentenceDto[]>([]);
  /** 提交中：防止双击重复写入听写记录，且避免未保存就切到下一句 */
  const [submitting, setSubmitting] = useState(false);
  /** B：当日已完成句子（句 id → 最佳正确率），刷新后仍展示完成态 */
  const [doneRates, setDoneRates] = useState<Record<string, number>>({});

  useEffect(() => { if (!loaded) refresh().catch(() => {}); }, [loaded, refresh]);

  const refreshToday = useCallback(() => {
    api<TodayTaskDto>('/stats/today').then(setToday).catch(() => {});
  }, []);
  useEffect(() => { refreshToday(); }, [refreshToday]);

  // 计划 → 听写清单（B1：并入我的自定义材料；P2-2：含没听懂优先句的材料排前面）
  useEffect(() => {
    if (!plan) return;
    setError('');
    Promise.all([
      apiGet<ContentItemDto[]>(`/content/items?packId=${plan.packId}&list=dictation`),
      api<ContentItemDto[]>('/content/my-items?list=dictation').catch(() => [] as ContentItemDto[]),
      api<DictationPriorityDto>(`/learning/dictation/priority?packId=${plan.packId}&date=${todayLocal()}`).catch(() => ({ sentenceIds: [], itemIds: [] })),
    ])
      .then(([official, mine, prio]) => {
        setPriority(prio);
        priorityIdsRef.current = prio.sentenceIds;
        const rank = new Map(prio.itemIds.map((id, i) => [id, i]));
        // 计划包材料与「我的材料」可能重叠（自定义包同时属于计划），按 id 去重避免重复篇目
        const merged = new Map([...official, ...mine].map((it) => [it.id, it]));
        const sorted = [...merged.values()].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
        setItems(sorted);
        setItemIdx(0);
        setItemsLoaded(true);
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'));
  }, [plan, reloadKey]);

  // 材料 → 句切片（P2-2：没听懂优先句排前面，其余保持原句序）
  // J1：若来自搜索命中句，则加载完成后直接定位到该句进入听写
  const currentItem = items[itemIdx] ?? null;
  useEffect(() => {
    if (!currentItem) return;
    apiGet<SentenceDto[]>(`/content/items/${currentItem.id}/sentences`)
      .then((list) => {
        const rank = new Map(priorityIdsRef.current.map((id, i) => [id, i]));
        const sorted = [...list].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
        fullSentences.current = sorted;
        setSentences(sorted);
        setInput(''); setResult(null); setListenCount(0);
        setResults([]);
        const pending = pendingSentence.current;
        pendingSentence.current = '';
        const jumpIdx = pending ? sorted.findIndex((s) => s.id === pending) : -1;
        if (jumpIdx >= 0) {
          setSentIdx(jumpIdx);
          setPhase('work');
        } else {
          setSentIdx(0);
          setPhase('prelisten');
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载句子失败'));
    api<{ sentence: { id: string } }[]>('/learning/favorites')
      .then((list) => setFavoriteIds(new Set(list.map((f) => f.sentence.id))))
      .catch(() => {});
    // B：拉当日听写记录，重建「已完成」状态（保留多次尝试，只取最佳正确率）
    api<{ sentenceId: string; correctRate: number }[]>(
      `/learning/dictation/today?date=${todayLocal()}&itemId=${currentItem.id}`,
    )
      .then((rows) => setDoneRates(Object.fromEntries(rows.map((r) => [r.sentenceId, r.correctRate]))))
      .catch(() => setDoneRates({}));
  }, [currentItem]);

  // J1 内容搜索：250ms 防抖，限定当前计划包 + 本人材料、听写清单
  useEffect(() => {
    const q = query.trim();
    if (!q || !plan) { setSearch(null); return; }
    const timer = window.setTimeout(() => {
      setSearching(true);
      api<ContentSearchDto>(`/content/search?q=${encodeURIComponent(q)}&packId=${plan.packId}&list=dictation`)
        .then(setSearch)
        .catch(() => setSearch(null))
        .finally(() => setSearching(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, plan]);

  /** J1 跳转到搜索命中的材料/句子：切篇，命中句则加载后直接落到该句 */
  const jumpTo = useCallback((itemId: string, sentenceId: string | null) => {
    const idx = items.findIndex((it) => it.id === itemId);
    if (idx < 0) return;
    setQuery(''); setSearch(null); setError('');
    if (sentenceId && idx === itemIdx) {
      const fi = fullSentences.current.findIndex((s) => s.id === sentenceId);
      if (fi >= 0) {
        setSentences(fullSentences.current);
        setSentIdx(fi); setPhase('work');
        setInput(''); setResult(null); setListenCount(0);
      }
      return;
    }
    pendingSentence.current = sentenceId ?? '';
    if (!sentenceId && idx === itemIdx) setPhase('prelisten');
    setItemIdx(idx);
  }, [items, itemIdx, sentences]);

  const currentSentence = sentences[sentIdx] ?? null;
  /** K1 小结：错句 = 正确率未满或含错词 */
  const wrongResults = results.filter((r) => r.correctRate < 1 || r.wrongWords.length > 0);
  const avgRate = results.length
    ? results.reduce((sum, r) => sum + r.correctRate, 0) / results.length
    : 0;

  const submitSentence = useCallback(async () => {
    if (!currentSentence || submitting) return;
    const graded = gradeDictation(currentSentence.text, input, mode);
    setResult(graded);
    setSubmitting(true);
    try {
      await api('/learning/dictation', {
        method: 'POST',
        body: JSON.stringify({
          sentenceId: currentSentence.id,
          date: todayLocal(),
          input,
          correctRate: graded.correctRate,
          replayCount: Math.max(0, listenCount - 1),
          wrongWords: graded.wrongWords,
        }),
      });
      setResults((rs) => [...rs, {
        sentenceId: currentSentence.id,
        text: currentSentence.text,
        correctRate: graded.correctRate,
        wrongWords: graded.wrongWords,
      }]);
      setDoneRates((m) => ({
        ...m,
        [currentSentence.id]: Math.max(m[currentSentence.id] ?? 0, graded.correctRate),
      }));
      // P2-2：该句已听写，移出优先队列（与服务端「当日已听写不再优先」口径一致）
      setPriority((p) => ({ ...p, sentenceIds: p.sentenceIds.filter((id) => id !== currentSentence.id) }));
      refreshToday();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  }, [currentSentence, input, mode, listenCount, refreshToday, submitting]);

  const nextSentence = useCallback(() => {
    if (submitting) return;
    setInput('');
    setResult(null);
    setListenCount(0);
    if (sentIdx + 1 < sentences.length) {
      setSentIdx((i) => i + 1);
    } else {
      setPhase('done');
    }
  }, [sentences.length, sentIdx, submitting]);

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

  if (!loaded) return <p className="muted">加载中…</p>;
  if (!plan) {
    return (
      <div className="card">
        <h2>还没有学习计划</h2>
        <p className="muted">先创建三阶段计划，再进入听写训练。</p>
        <Link to="/onboarding"><button className="btn">创建计划</button></Link>
      </div>
    );
  }
  if (!currentItem) {
    // 材料清单已加载完但为空：给出明确引导，避免永久停在「加载中…」
    if (itemsLoaded && items.length === 0 && !error) {
      return (
        <div className="card">
          <h2>听写清单还是空的</h2>
          <p className="muted">当前计划包没有可听写的材料。可以在「我的材料」导入自己的内容，或到计划页更换内容包。</p>
          <div className="row">
            <Link to="/materials"><button className="btn">去我的材料</button></Link>
            <Link to="/plan"><button className="btn ghost">查看计划</button></Link>
          </div>
        </div>
      );
    }
    // 清单加载失败：给出原因与重试入口，而不是一直「加载中…」
    if (error) {
      return (
        <div className="card">
          <h2>听写清单加载失败</h2>
          <p style={{ color: '#b42318' }}>{error}</p>
          <div className="row">
            <button className="btn" onClick={() => { setError(''); setItemsLoaded(false); setReloadKey((k) => k + 1); }}>
              重试
            </button>
            <Link to="/"><button className="btn ghost">回到今日</button></Link>
          </div>
        </div>
      );
    }
    return <p className="muted">加载中…</p>;
  }

  return (
    <div>
      <div className="card">
        <h2>阶段二 · 逐句听写</h2>
        <p className="muted">
          {today
            ? `今日进度 ${today.progress} / ${today.goal} ${({ minutes: '分钟', passages: '篇', sentences: '句' } as const)[today.unit]} · `
            : ''}
          整篇预听一遍，再逐句键入并批改（错词自动进错词本）。
        </p>
        {items.length > 1 && (
          <div className="row">
            <button
              className="btn ghost"
              onClick={() => setItemIdx((i) => (i + 1) % items.length)}
            >
              换一篇（{itemIdx + 1}/{items.length}）
            </button>
          </div>
        )}
      </div>

      {/* J1 搜索：按材料标题或句子关键词定位，点击结果直接切篇；命中句直接进入该句听写 */}
      <div className="card">
        <h2>搜索听写内容</h2>
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
            <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>没有匹配的听写材料或句子。</p>
          )
        )}
      </div>

      {error && <p style={{ color: '#b42318' }}>{error}</p>}

      {phase === 'prelisten' && (
        <div className="card">
          <h2>{currentItem.title}</h2>
          {Object.keys(doneRates).length > 0 && (
            <p className="muted">
              今日已完成 {Math.min(sentences.length, Object.keys(doneRates).length)} / {sentences.length} 句（重复提交会保留每次记录，此处显示最佳成绩）
            </p>
          )}
          {sentences.some((s) => priority.sentenceIds.includes(s.id)) && (
            <p><span className="tag warn">没听懂优先</span> <span className="muted">本篇含你标记过没听懂的句子，已排在前面。</span></p>
          )}
          <AudioWithOffline src={currentItem.audioUrl} />
          <div className="row">
            <button className="btn" onClick={() => setPhase('work')}>开始逐句听写</button>
          </div>
        </div>
      )}

      {phase === 'work' && currentSentence && (
        <div className="card">
          <h2>
            第 {sentIdx + 1} / {sentences.length} 句
            {doneRates[currentSentence.id] !== undefined && (
              <> <span className="tag">今日已完成 · 最佳 {Math.round(doneRates[currentSentence.id] * 100)}%</span></>
            )}
            {priority.sentenceIds.includes(currentSentence.id) && (
              <> <span className="tag warn">没听懂优先</span></>
            )}
          </h2>
          <div className="row">
            <button className="btn ghost" onClick={() => setMode(mode === GradingMode.LENIENT ? GradingMode.STRICT : GradingMode.LENIENT)}>
              {mode === GradingMode.LENIENT ? '宽容模式' : '严格模式'}
            </button>
            <button
              className={favoriteIds.has(currentSentence.id) ? 'btn' : 'btn ghost'}
              onClick={() => toggleFavorite(currentSentence.id)}
            >
              {favoriteIds.has(currentSentence.id) ? '已收藏' : '收藏这句'}
            </button>
            <span className="muted">已听 {listenCount} 次</span>
          </div>
          <AudioWithOffline
            src={currentSentence.audioUrl}
            onPlay={() => setListenCount((c) => c + 1)}
          />
          {listenCount > REPLAY_HINT_THRESHOLD && !result && (
            <p className="muted">这段反复听了很多次，先跳过、稍后再回来也可以。</p>
          )}

          {!result && (
            <>
              <div style={{ margin: '12px 0' }}>
                <input
                  type="text"
                  placeholder="播放后键入你听到的句子，回车检查"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && input.trim() && !submitting) submitSentence(); }}
                />
              </div>
              <div className="row">
                <button className="btn" disabled={!input.trim() || submitting} onClick={submitSentence}>
                  {submitting ? '保存中…' : '检查'}
                </button>
              </div>
            </>
          )}

          {result && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 15, lineHeight: 1.9 }}>
                {result.marks.map((m, i) => <Mark key={i} m={m} />)}
              </div>
              <p className="muted">
                正确率 {Math.round(result.correctRate * 100)}%
                {result.wrongWords.length > 0 && ` · 错词 ${result.wrongWords.join('、')}`}
              </p>
              <div className="row">
                <button className="btn" disabled={submitting} onClick={nextSentence}>
                  {submitting ? '保存中…' : sentIdx + 1 < sentences.length ? '下一句' : '完成本篇'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {phase === 'done' && (
        <div className="card">
          <h2>本篇听写完成</h2>
          <p className="muted">
            本次共提交 {results.length} 句
            {results.length > 0 && ` · 平均正确率 ${Math.round(avgRate * 100)}%`}；错词已进入错词本，后续用于复习。
          </p>
          {wrongResults.length > 0 ? (
            <div style={{ marginBottom: 10 }}>
              <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
                本篇错句 {wrongResults.length} 句（正确率未满或含错词）：
              </div>
              {wrongResults.map((r) => (
                <div key={r.sentenceId} style={{ fontSize: 14, marginBottom: 6 }}>
                  <div>{r.text}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    正确率 {Math.round(r.correctRate * 100)}%
                    {r.wrongWords.length > 0 && ` · 错词 ${r.wrongWords.join('、')}`}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            results.length > 0 && <p className="muted">本篇全部正确，没有需要重练的错句。</p>
          )}
          <div className="row">
            {wrongResults.length > 0 && (
              <button className="btn" onClick={() => {
                const ids = new Set(wrongResults.map((r) => r.sentenceId));
                setSentences(fullSentences.current.filter((s) => ids.has(s.id)));
                setSentIdx(0); setPhase('work'); setInput(''); setResult(null); setListenCount(0);
                setResults([]);
              }}>
                只重练错句（{wrongResults.length}）
              </button>
            )}
            <button className="btn ghost" onClick={() => {
              setSentences(fullSentences.current);
              setSentIdx(0); setPhase('prelisten'); setInput(''); setResult(null); setListenCount(0);
              setResults([]);
            }}>
              再练一遍
            </button>
            <Link to="/"><button className="btn ghost">回到今日</button></Link>
          </div>
        </div>
      )}
    </div>
  );
}
