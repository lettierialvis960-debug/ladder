import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { StageStatus, StageType } from '@ladder/shared';
import type { PlanDto, StageDto } from '@ladder/shared';
import { api } from '../../api/client';
import { usePlanStore } from '../../stores/plan';

const STAGE_META: Record<StageType, { title: string; desc: string; path: string }> = {
  [StageType.LISTEN]: { title: '阶段一 · 沉浸听力', desc: '先听够量，磨耳朵', path: '/listen' },
  [StageType.DICTATE]: { title: '阶段二 · 逐句听写', desc: '写得出，才算听懂', path: '/dictation' },
  [StageType.SPEAK]: { title: '阶段三 · 口语输出', desc: '说得出，才算学会', path: '/speaking' },
};

const STATUS_TAG: Record<string, { text: string; cls: string }> = {
  [StageStatus.ACTIVE]: { text: '进行中', cls: 'tag' },
  [StageStatus.DONE]: { text: '已完成', cls: 'tag done' },
  [StageStatus.SKIPPED]: { text: '已提前切换', cls: 'tag' },
  [StageStatus.LOCKED]: { text: '未解锁', cls: 'tag locked' },
};

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const dayDiff = (from: string, to: string) => Math.floor((Date.parse(to) - Date.parse(from)) / 86400000);

/** G1：调整进行中阶段的天数（不能少于已进行天数，保存后刷新计划） */
function StageAdjust({ stage, onSaved }: { stage: StageDto; onSaved: () => void }) {
  const [days, setDays] = useState(stage.plannedDays);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => { setDays(stage.plannedDays); }, [stage.plannedDays]);

  const save = async () => {
    setBusy(true); setMsg('');
    try {
      await api(`/plans/current/stages/${stage.seq}`, {
        method: 'PATCH',
        body: JSON.stringify({ plannedDays: days }),
      });
      setMsg('已更新');
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '调整失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row" style={{ marginTop: 8 }}>
      <span className="muted">调整天数</span>
      <input
        type="number"
        min={15}
        max={180}
        value={days}
        style={{ width: 80 }}
        onChange={(e) => setDays(Number(e.target.value))}
      />
      <button
        className="btn ghost"
        disabled={busy || days === stage.plannedDays || !Number.isInteger(days)}
        onClick={() => void save()}
      >
        保存
      </button>
      {msg && <span className="muted">{msg}</span>}
    </div>
  );
}

/** 计划详情页（FR-01/FR-06）：三阶段状态、天数、起止日期、完成率与解锁条件；无计划时引导创建。 */
export function PlanPage() {
  const { plan, loaded, refresh } = usePlanStore();
  // G3 重开：无进行中计划时展示最近一次计划配置
  const [lastPlan, setLastPlan] = useState<PlanDto | null>(null);
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartErr, setRestartErr] = useState('');

  useEffect(() => { refresh().catch(() => {}); }, [refresh]);
  useEffect(() => {
    if (!loaded || plan) { setLastPlan(null); return; }
    api<PlanDto | null>('/plans/last').then(setLastPlan).catch(() => setLastPlan(null));
  }, [loaded, plan]);

  const restart = async () => {
    setRestartBusy(true); setRestartErr('');
    try {
      await api('/plans/restart', { method: 'POST' });
      await refresh();
    } catch (e) {
      setRestartErr(e instanceof Error ? e.message : '重开失败');
    } finally {
      setRestartBusy(false);
    }
  };

  if (!loaded) return <p className="muted">加载中…</p>;

  if (!plan) {
    return (
      <div>
        <div className="card">
          <h2>还没有学习计划</h2>
          <p className="muted">三步听力法：先听够量，再写得出，最后说得出。</p>
          <Link to="/onboarding"><button className="btn">创建三阶段计划</button></Link>
        </div>
        {lastPlan && (
          <div className="card">
            <h2>上次计划</h2>
            <p className="muted">
              {lastPlan.levelCode} · {lastPlan.status === 'COMPLETED' ? '已完成' : lastPlan.status} · 创建于 {lastPlan.createdAt.slice(0, 10)}
            </p>
            <p className="muted">各阶段天数：{lastPlan.stages.map((s) => `${s.plannedDays} 天`).join(' / ')}</p>
            <div className="row">
              <button className="btn" disabled={restartBusy} onClick={() => void restart()}>
                {restartBusy ? '正在重开…' : '沿用上次配置重新开始'}
              </button>
            </div>
            {restartErr && <p style={{ color: '#b42318' }}>{restartErr}</p>}
          </div>
        )}
      </div>
    );
  }

  const today = localToday();

  return (
    <div>
      <div className="card">
        <h2>我的计划 <span className="tag">{plan.status === 'ACTIVE' ? '进行中' : plan.status}</span></h2>
        <ul>
          <li>级别：{plan.levelCode}</li>
          <li>内容包：{plan.packTitle ?? '未知内容包'}</li>
          <li>创建日期：{plan.createdAt.slice(0, 10)}</li>
        </ul>
      </div>

      {plan.stages.map((s) => {
        const meta = STAGE_META[s.type as StageType];
        const tag = STATUS_TAG[s.status] ?? { text: s.status, cls: 'tag' };
        const elapsed = s.startDate ? dayDiff(s.startDate, today) : 0;
        const remain = s.plannedDays - elapsed;
        return (
          <div className="card" key={s.id}>
            <h2>{meta.title} <span className={tag.cls}>{tag.text}</span></h2>
            <div className="muted">阶段 {s.seq} · {meta.desc} · 计划 {s.plannedDays} 天</div>

            {s.status === StageStatus.ACTIVE && (
              <>
                <ul>
                  <li>已进行 {elapsed} 天 / 共 {s.plannedDays} 天{remain > 0 ? `（还差 ${remain} 天可推进）` : '（天数已够，可申请推进）'}</li>
                  <li>起止：{s.startDate ?? '—'} → {s.endDate ?? '—'}</li>
                </ul>
                <StageAdjust stage={s} onSaved={() => { void refresh(); }} />
                <div className="row"><Link to={meta.path}><button className="btn">开始今日任务</button></Link></div>
              </>
            )}

            {s.status === StageStatus.LOCKED && (
              <>
                <div className="muted">{s.unlockHint ?? '完成上一阶段后解锁'}</div>
                <StageAdjust stage={s} onSaved={() => { void refresh(); }} />
              </>
            )}

            {(s.status === StageStatus.DONE || s.status === StageStatus.SKIPPED) && (
              <ul>
                <li>起止：{s.startDate ?? '—'} → {s.endDate ?? '—'}</li>
                <li>完成率：{Math.round(s.completionRate * 100)}%</li>
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
