import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ContentPackDto, LevelDto } from '@ladder/shared';
import { STAGE1_DAY_OPTIONS, STAGE2_DEFAULT_DAYS, STAGE3_DEFAULT_DAYS } from '@ladder/shared';
import { api } from '../../api/client';

/**
 * FR-01 分级引导与计划创建：选级别（可跳过小测）→ 选内容包 → 设阶段时长 → 生成计划。
 * TODO[骨架]：听力小测（3 段音频 + 大意选择题）暂不实现，先提供“自选级别”主路径。
 */
export function OnboardingPage() {
  const nav = useNavigate();
  const [levels, setLevels] = useState<LevelDto[]>([]);
  const [levelCode, setLevelCode] = useState<string | null>(null);
  const [packs, setPacks] = useState<ContentPackDto[]>([]);
  const [packId, setPackId] = useState<string | null>(null);
  const [stage1Days, setStage1Days] = useState<number>(45);
  const [error, setError] = useState('');
  /** 级别/内容包加载失败：显式提示并可重试，避免空列表卡住流程 */
  const [levelsError, setLevelsError] = useState('');
  const [packsError, setPacksError] = useState('');
  const [packsLoading, setPacksLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setLevelsError('');
    api<LevelDto[]>('/levels')
      .then(setLevels)
      .catch((e) => setLevelsError(e instanceof Error ? e.message : '级别加载失败'));
  }, [reloadKey]);
  useEffect(() => {
    if (levelCode) {
      setPacksError('');
      setPacks([]);
      setPacksLoading(true);
      api<ContentPackDto[]>(`/content/packs?level=${levelCode}`)
        .then((list) => setPacks([...list].sort((a, b) => (b.durationMin ?? 0) - (a.durationMin ?? 0))))
        .catch((e) => setPacksError(e instanceof Error ? e.message : '内容包加载失败'))
        .finally(() => setPacksLoading(false));
    }
  }, [levelCode, reloadKey]);

  const submit = async () => {
    if (!levelCode || !packId) return;
    setError('');
    try {
      await api('/plans', {
        method: 'POST',
        body: JSON.stringify({ levelCode, packId, stage1Days, stage2Days: STAGE2_DEFAULT_DAYS, stage3Days: STAGE3_DEFAULT_DAYS }),
      });
      nav('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    }
  };
  /** 409 冲突：用户已有 ACTIVE 计划 → 显示引导链接到计划页，避免用户卡死 */
  const hasActivePlanConflict = error.includes('已有进行中的计划');

  return (
    <div>
      <div className="card">
        <h2>第 1 步 · 选择级别</h2>
        <p className="muted">按当前水平选择；分级小测后续提供，可随时在计划中调整。</p>
        {levelsError && (
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <p style={{ color: '#b42318', margin: 0 }}>{levelsError}</p>
            <button className="btn ghost" onClick={() => setReloadKey((k) => k + 1)}>重试</button>
          </div>
        )}
        {levels.map((lv) => (
          <div key={lv.code} className="row">
            <button className={levelCode === lv.code ? 'btn' : 'btn ghost'} onClick={() => { setLevelCode(lv.code); setPackId(null); }}>
              {lv.name}（{lv.audience}）
            </button>
          </div>
        ))}
      </div>

      {levelCode && (
        <div className="card">
          <h2>第 2 步 · 选择内容包</h2>
          {packsError ? (
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <p style={{ color: '#b42318', margin: 0 }}>{packsError}</p>
              <button className="btn ghost" onClick={() => setReloadKey((k) => k + 1)}>重试</button>
            </div>
          ) : packsLoading ? (
            <p className="muted">加载内容包…</p>
          ) : packs.length === 0 ? (
            <p className="muted">该级别暂无可选内容包。</p>
          ) : null}
          {packs.map((p) => (
            <div key={p.id} className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <button className={packId === p.id ? 'btn' : 'btn ghost'} onClick={() => setPackId(p.id)}>
                {p.title} · {p.itemCount} 篇{p.sentenceCount ? ` · ${p.sentenceCount} 句` : ''}
                {p.durationMin ? ` · 约 ${p.durationMin} 分钟` : ''}
              </button>
            </div>
          ))}
        </div>
      )}

      {packId && (
        <div className="card">
          <h2>第 3 步 · 听力期时长（方法论 1–2 个月）</h2>
          <div className="row">
            {STAGE1_DAY_OPTIONS.map((d) => (
              <button key={d} className={stage1Days === d ? 'btn' : 'btn ghost'} onClick={() => setStage1Days(d)}>{d} 天</button>
            ))}
          </div>
          <p className="muted">听写期默认 {STAGE2_DEFAULT_DAYS} 天 · 口语期默认 {STAGE3_DEFAULT_DAYS} 天，均可在计划中调整。</p>
          {error && (
            hasActivePlanConflict ? (
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ color: '#b42318', margin: 0 }}>{error}</p>
                <Link to="/plan"><button className="btn ghost">前往我的计划调整</button></Link>
              </div>
            ) : (
              <p style={{ color: '#b42318' }}>{error}</p>
            )
          )}
          <button className="btn" onClick={submit}>生成我的三阶段计划</button>
        </div>
      )}
    </div>
  );
}
