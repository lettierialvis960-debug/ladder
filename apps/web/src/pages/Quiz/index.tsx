import { useCallback, useEffect, useState } from 'react';
import { LevelCode } from '@ladder/shared';
import type { QuizSessionDto, QuizSubmitResultDto } from '@ladder/shared';
import { api } from '../../api/client';

const LEVELS: { code: LevelCode; name: string }[] = [
  { code: LevelCode.L1, name: '初阶 L1' },
  { code: LevelCode.L2, name: '中阶 L2' },
  { code: LevelCode.L3, name: '高阶 L3' },
];

/** P1-3 分级小测：听句子选译文，检验当前级别水平 */
export function QuizPage() {
  const [levelCode, setLevelCode] = useState<LevelCode>(LevelCode.L1);
  const [count, setCount] = useState(10);
  const [generating, setGenerating] = useState(false);
  const [session, setSession] = useState<QuizSessionDto | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<QuizSubmitResultDto | null>(null);
  const [history, setHistory] = useState<QuizSubmitResultDto[] | any[]>([]);

  const loadHistory = useCallback(async () => {
    try {
      const list = await api<any[]>('/quiz/history/list');
      setHistory(list);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const start = async () => {
    setGenerating(true); setResult(null); setAnswers({});
    try {
      const s = await api<QuizSessionDto>(`/quiz/generate?levelCode=${levelCode}&count=${count}`);
      setSession(s);
    } catch (e) {
      alert(e instanceof Error ? e.message : '生成小测失败');
    } finally {
      setGenerating(false);
    }
  };

  const submit = async () => {
    if (!session) return;
    setSubmitting(true);
    try {
      const r = await api<QuizSubmitResultDto>(`/quiz/${session.id}/submit`, {
        method: 'POST',
        body: JSON.stringify({
          answers: session.questions.map((q) => ({ questionId: q.id, answer: answers[q.id] ?? '' })),
        }),
      });
      setResult(r);
      loadHistory();
    } catch (e) {
      alert(e instanceof Error ? e.message : '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h2>分级小测</h2>
        <p className="muted">听句子，选出正确译文，检验当前级别听力水平。正确率 ≥60% 视为通过。</p>
        <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="muted">级别
            <select value={levelCode} onChange={(e) => setLevelCode(e.target.value as LevelCode)} style={{ marginLeft: 8 }}>
              {LEVELS.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </label>
          <label className="muted">题数
            <input type="number" min={5} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 70, marginLeft: 8 }} />
          </label>
          <button className="btn" disabled={generating} onClick={() => void start()}>
            {generating ? '生成中…' : '开始小测'}
          </button>
        </div>
      </div>

      {session && !result && (
        <div className="card">
          <h2>答题中（共 {session.total} 题）</h2>
          {session.questions.map((q, idx) => (
            <div key={q.id} style={{ marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid #eee' }}>
              <p><b>第 {idx + 1} 题</b> · {q.prompt}</p>
              {q.audioUrl && (
                <audio controls src={q.audioUrl} preload="none" style={{ width: '100%', maxWidth: 400 }} />
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                {q.options.map((opt) => (
                  <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name={q.id}
                      checked={answers[q.id] === opt}
                      onChange={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                    />
                    <span>{opt}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          <button className="btn" disabled={submitting} onClick={() => void submit()}>
            {submitting ? '提交中…' : '提交并查看成绩'}
          </button>
        </div>
      )}

      {result && (
        <div className="card">
          <h2>
            成绩：{result.score} / {result.total}
            <span className={`tag ${result.passed ? 'done' : ''}`} style={{ marginLeft: 8 }}>
              {result.passed ? '通过' : '未通过'}
            </span>
          </h2>
          <p className="muted">{result.suggestion}</p>
          <ul style={{ fontSize: 13 }}>
            {result.details.map((d) => (
              <li key={d.questionId} style={{ color: d.correct ? '#1a7f37' : '#b42318' }}>
                {d.correct ? '✓' : '✗'} 你的答案：{d.answer || '（未作答）'}
                {!d.correct && <> — 正确：{d.correctAnswer}</>}
              </li>
            ))}
          </ul>
          <button className="btn" onClick={() => { setSession(null); setResult(null); }}>再来一次</button>
        </div>
      )}

      {history.length > 0 && (
        <div className="card">
          <h2>最近小测</h2>
          <ul style={{ fontSize: 13 }}>
            {history.map((h) => (
              <li key={h.id}>
                {h.levelCode} · {h.score != null ? `${h.score}/${h.total}` : '未完成'}
                {h.passed != null && <span className={`tag ${h.passed ? 'done' : ''}`} style={{ marginLeft: 8 }}>{h.passed ? '通过' : '未通过'}</span>}
                <span className="muted" style={{ marginLeft: 8 }}>{new Date(h.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
