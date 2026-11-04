import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GradingMode, REPLAY_HINT_THRESHOLD } from '@ladder/shared';
import type { WeakDrillItemDto } from '@ladder/shared';
import { api } from '../../api/client';
import { gradeDictation } from '../../lib/dictationGrader';
import type { GradeResult, WordMark } from '../../lib/dictationGrader';
import { todayLocal } from '../../lib/date';
import { AudioWithOffline } from '../../components/AudioWithOffline';

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
 * A1 弱项专项训练：把「没听懂 / 错词 / 近 14 天低正确率」的句子聚合起来逐句精听 + 听写。
 * 训练结果复用 /learning/dictation 上报，自动更新错词本与打卡进度。
 */
export function DrillPage() {
  const [items, setItems] = useState<WeakDrillItemDto[]>([]);
  const [idx, setIdx] = useState(0);
  const [input, setInput] = useState('');
  const [result, setResult] = useState<GradeResult | null>(null);
  const [mode, setMode] = useState<GradingMode>(GradingMode.LENIENT);
  const [listenCount, setListenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [error, setError] = useState('');
  /** 提交中：防止双击重复写入听写记录，且避免未保存就切到下一句 */
  const [submitting, setSubmitting] = useState(false);
  /** 加载失败与「真的没有弱项」需区分，失败时提供重试 */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError('');
    api<WeakDrillItemDto[]>('/learning/weak-drill?limit=10')
      .then((list) => { setItems(list); setLoading(false); })
      .catch((e) => { setError(e instanceof Error ? e.message : '加载失败'); setLoading(false); });
  }, [reloadKey]);

  const current = items[idx] ?? null;

  const submit = useCallback(async () => {
    if (!current || submitting) return;
    const graded = gradeDictation(current.text, input, mode);
    setResult(graded);
    setSubmitting(true);
    try {
      await api('/learning/dictation', {
        method: 'POST',
        body: JSON.stringify({
          sentenceId: current.id,
          date: todayLocal(),
          input,
          correctRate: graded.correctRate,
          replayCount: Math.max(0, listenCount - 1),
          wrongWords: graded.wrongWords,
        }),
      });
      setSavedCount((c) => c + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  }, [current, input, mode, listenCount, submitting]);

  const next = () => {
    if (submitting) return;
    setInput(''); setResult(null); setListenCount(0);
    if (idx + 1 < items.length) setIdx((i) => i + 1);
    else setDone(true);
  };

  if (loading) return <p className="muted">加载中…</p>;

  if (items.length === 0) {
    if (error) {
      return (
        <div className="card">
          <h2>弱项加载失败</h2>
          <p style={{ color: '#b42318' }}>{error}</p>
          <p className="muted">弱项清单暂时取不到，请稍后重试。</p>
          <div className="row">
            <button className="btn" onClick={() => setReloadKey((k) => k + 1)}>重试</button>
            <Link to="/"><button className="btn ghost">回到今日</button></Link>
          </div>
        </div>
      );
    }
    return (
      <div className="card">
        <h2>暂无弱项</h2>
        <p className="muted">
          弱项来自三处：听力中标记「没听懂」、听写错词、近 14 天听写正确率低于 80% 的句子。
          先去积累一些练习吧。
        </p>
        <div className="row">
          <Link to="/listen"><button className="btn">去听力</button></Link>
          <Link to="/dictation"><button className="btn ghost">去听写</button></Link>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="card">
        <h2>本轮弱项训练完成</h2>
        <p className="muted">共练 {savedCount} 句，结果已计入听写记录与错词本。</p>
        <div className="row">
          <button className="btn" onClick={() => { setIdx(0); setDone(false); setSavedCount(0); setInput(''); setResult(null); }}>
            再练一轮
          </button>
          <Link to="/"><button className="btn ghost">回到今日</button></Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h2>弱项专项训练</h2>
        <p className="muted">
          为你挑出 {items.length} 句最容易丢分的句子（没听懂 / 错词 / 近期听写正确率低），逐句精听并听写。
        </p>
      </div>

      {error && <p style={{ color: '#b42318' }}>{error}</p>}

      {current && (
        <div className="card">
          <h2>
            第 {idx + 1} / {items.length} 句
            {current.reasons.map((r) => (
              <span key={r} className="tag warn" style={{ marginLeft: 6 }}>{r}</span>
            ))}
          </h2>
          <p className="muted">来自《{current.itemTitle}》{current.words.length > 0 ? ` · 错词 ${current.words.join('、')}` : ''}</p>
          <div className="row">
            <button className="btn ghost" onClick={() => setMode(mode === GradingMode.LENIENT ? GradingMode.STRICT : GradingMode.LENIENT)}>
              {mode === GradingMode.LENIENT ? '宽容模式' : '严格模式'}
            </button>
            <span className="muted">已听 {listenCount} 次</span>
          </div>
          <AudioWithOffline src={current.audioUrl} onPlay={() => setListenCount((c) => c + 1)} />
          {listenCount > REPLAY_HINT_THRESHOLD && !result && (
            <p className="muted">反复听了很多次，先跳过、稍后再回来也可以。</p>
          )}

          {!result && (
            <>
              <div style={{ margin: '12px 0' }}>
                <input
                  type="text"
                  placeholder="播放后键入你听到的句子，回车检查"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && input.trim() && !submitting) submit(); }}
                />
              </div>
              <div className="row">
                <button className="btn" disabled={!input.trim() || submitting} onClick={submit}>
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
                <button className="btn" disabled={submitting} onClick={next}>
                  {submitting ? '保存中…' : idx + 1 < items.length ? '下一句' : '完成训练'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
