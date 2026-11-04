import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ContentItemDto, ItemProgressDto, PlanDto } from '@ladder/shared';
import { api } from '../../api/client';

/** E1 单篇材料进度行：听力时长 + 听写/跟读覆盖 */
function ProgressRow({ p }: { p: ItemProgressDto }) {
  const pct = (n: number) => (p.sentenceCount ? Math.round((n / p.sentenceCount) * 100) : 0);
  return (
    <div className="prog-row">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span>{p.title}</span>
        <span className="muted">已听 {Math.round(p.listenedSec / 60)} 分钟</span>
      </div>
      <div className="prog-line">
        <span className="muted" style={{ width: 36 }}>听写</span>
        <div className="prog-bar"><div className="dictate" style={{ width: `${pct(p.dictatedSentences)}%` }} /></div>
        <span className="muted" style={{ fontSize: 12, minWidth: 42 }}>{p.dictatedSentences}/{p.sentenceCount}</span>
      </div>
      <div className="prog-line">
        <span className="muted" style={{ width: 36 }}>跟读</span>
        <div className="prog-bar"><div className="speak" style={{ width: `${pct(p.spokenSentences)}%` }} /></div>
        <span className="muted" style={{ fontSize: 12, minWidth: 42 }}>{p.spokenSentences}/{p.sentenceCount}</span>
      </div>
    </div>
  );
}

/**
 * B1 我的材料：粘贴英文文本 → 服务端 Edge 神经语音自动切句合成音频 → 进入听力/听写清单。
 * 中文翻译按句一行可选；删除时连带清理本人学习记录与音频文件。
 */
export function MaterialsPage() {
  const [items, setItems] = useState<ContentItemDto[]>([]);
  const [planProgress, setPlanProgress] = useState<ItemProgressDto[]>([]);
  const [customProgress, setCustomProgress] = useState<ItemProgressDto[]>([]);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [translation, setTranslation] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  /** 我的材料列表加载失败：显式提示并提供重试，避免误显示「0 篇」 */
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(() => {
    setLoadError('');
    api<ContentItemDto[]>('/content/my-items')
      .then((list) => {
        setItems(list);
        const packId = list[0]?.packId;
        if (!packId) { setCustomProgress([]); return; }
        api<ItemProgressDto[]>(`/content/progress?packId=${packId}`)
          .then(setCustomProgress)
          .catch(() => setCustomProgress([]));
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : '我的材料加载失败'));
    api<PlanDto | null>('/plans/current')
      .then((plan) => {
        if (!plan) { setPlanProgress([]); return; }
        api<ItemProgressDto[]>(`/content/progress?packId=${plan.packId}`)
          .then(setPlanProgress)
          .catch(() => setPlanProgress([]));
      })
      .catch(() => {});
  }, [reloadKey]);
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (text.trim().length < 20) {
      setError('请至少粘贴一句完整英文（不少于 20 个字符）');
      return;
    }
    setBusy(true); setError(''); setMsg('');
    try {
      const item = await api<ContentItemDto>('/content/custom-import', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim() || undefined,
          text,
          translation: translation.trim() || undefined,
        }),
      });
      setMsg(`已生成「${item.title}」，可在听力与听写中使用`);
      setTitle(''); setText(''); setTranslation('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: ContentItemDto) => {
    if (!window.confirm(`删除「${item.title}」？该材料的听写/标记记录会一并清除。`)) return;
    try {
      await api(`/content/custom-items/${item.id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div>
      <div className="card">
        <h2>导入自定义材料</h2>
        <p className="muted">
          粘贴英文文本，系统自动按句拆分并合成语音（每句约 1–2 秒，整篇需稍等）。
          生成后可进入<Link to="/listen">沉浸听力</Link>或<Link to="/dictation">逐句听写</Link>；中文翻译按句一行，可留空。
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          <input
            type="text"
            placeholder="标题（可选，默认取首句）"
            value={title}
            maxLength={60}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
          />
          <textarea
            placeholder="English text. One or more sentences. Example: My name is Li Ming. I am twelve years old."
            value={text}
            maxLength={8000}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
            style={{ minHeight: 120 }}
          />
          <textarea
            placeholder="中文翻译（可选，一行对应一句，行数需与句数一致）"
            value={translation}
            maxLength={8000}
            onChange={(e) => setTranslation(e.target.value)}
            disabled={busy}
            style={{ minHeight: 80 }}
          />
        </div>
        {error && <p style={{ color: '#b42318' }}>{error}</p>}
        {msg && <p style={{ color: '#067647' }}>{msg}</p>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={submit} disabled={busy}>
            {busy ? '正在生成音频，请稍候…' : '生成音频并加入我的材料'}
          </button>
          <Link to="/listen" className="btn ghost">去听力</Link>
        </div>
      </div>

      {(planProgress.length > 0 || customProgress.length > 0) && (
        <div className="card">
          <h2>学习进度</h2>
          <p className="muted">按材料统计有效听力时长，以及听写/跟读覆盖的句子数（去重）。</p>
          {planProgress.length > 0 && (
            <>
              <h4 style={{ margin: '10px 0 0', fontSize: 14 }}>当前计划材料</h4>
              {planProgress.map((p) => <ProgressRow key={p.itemId} p={p} />)}
            </>
          )}
          {customProgress.length > 0 && (
            <>
              <h4 style={{ margin: '10px 0 0', fontSize: 14 }}>我的材料</h4>
              {customProgress.map((p) => <ProgressRow key={p.itemId} p={p} />)}
            </>
          )}
        </div>
      )}

      <div className="card">
        <h2>我的材料（{items.length}）</h2>
        {loadError ? (
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <b style={{ color: '#b42318' }}>我的材料加载失败</b>
              <p className="muted" style={{ margin: '4px 0 0' }}>{loadError}</p>
            </div>
            <button className="btn ghost" onClick={() => setReloadKey((k) => k + 1)}>重试</button>
          </div>
        ) : items.length === 0 ? (
          <p className="muted">还没有自定义材料。导入后会同时出现在听力与听写清单里。</p>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="row"
              style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #eef1f6' }}
            >
              <div>
                <div>{item.title}</div>
                <div className="muted">
                  {item.sentenceCount ?? '-'} 句 · 约 {Math.max(1, Math.round(item.durationSec / 60))} 分钟
                </div>
              </div>
              <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 13 }} onClick={() => remove(item)}>
                删除
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
