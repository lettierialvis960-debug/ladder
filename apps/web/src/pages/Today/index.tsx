import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { StageStatus } from '@ladder/shared';
import type { AutoAdvanceDto, TodayTaskDto, WrongWordDueDto } from '@ladder/shared';
import { api } from '../../api/client';
import { usePlanStore } from '../../stores/plan';
import { TaskCard } from '../../components/TaskCard';
import { RecoveryBanner } from '../../components/RecoveryBanner';

const UNIT_LABEL = { minutes: '分钟', passages: '篇', sentences: '句' } as const;

/** 今日页（FR-07）：三阶段任务卡 + 当日进度。进度数字来自 /stats/today。 */
export function TodayPage() {
  const { plan, loaded, refresh } = usePlanStore();
  const [today, setToday] = useState<TodayTaskDto | null>(null);
  /** J3 待复习错词（到期/逾期数量），用于今日页提醒 */
  const [due, setDue] = useState<WrongWordDueDto | null>(null);
  const [notice, setNotice] = useState('');
  /** 今日进度/待复习加载失败：显式提示并支持重试，避免永久停在「加载中…」 */
  const [statsError, setStatsError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const autoTried = useRef('');

  useEffect(() => { refresh().catch(() => {}); }, [refresh]);

  /** E3：每次进入今日页尝试一次自动推进（同计划只尝试一次，未达标不改变状态） */
  useEffect(() => {
    if (!plan || autoTried.current === plan.id) return;
    autoTried.current = plan.id;
    const hasActive = plan.stages.some((s) => s.status === StageStatus.ACTIVE);
    if (!hasActive) return;
    api<AutoAdvanceDto>('/plans/current/auto-advance', { method: 'POST' })
      .then((r) => {
        if (!r?.advanced) return;
        const label = r.stageType === 'LISTEN' ? '听力期' : r.stageType === 'DICTATE' ? '听写期' : '口语期';
        setNotice(`${label}已达标，系统已自动进入下一阶段`);
        void refresh();
      })
      .catch(() => {});
  }, [plan, refresh]);
  useEffect(() => {
    if (!plan) { setToday(null); setDue(null); setStatsError(''); return; }
    let alive = true;
    setStatsError('');
    api<TodayTaskDto>('/stats/today')
      .then((r) => { if (alive) setToday(r); })
      .catch((e) => { if (alive) setStatsError(e instanceof Error ? e.message : '今日进度加载失败'); });
    api<WrongWordDueDto>('/learning/wrong-words/due')
      .then((r) => { if (alive) setDue(r); })
      .catch(() => {});
    return () => { alive = false; };
  }, [plan, reloadKey]);

  if (!loaded) return <p className="muted">加载中…</p>;
  if (!plan) {
    return (
      <div className="card">
        <h2>还没有学习计划</h2>
        <p className="muted">三步听力法：先听够量，再写得出，最后说得出。</p>
        <Link to="/onboarding"><button className="btn">创建三阶段计划</button></Link>
      </div>
    );
  }

  return (
    <div>
      {notice && (
        <div className="card" style={{ background: '#f0fdf4', borderColor: '#bbf7d0' }}>
          <b style={{ color: '#067647' }}>{notice}</b>
          <p className="muted" style={{ marginTop: 4 }}>新阶段已解锁，今日任务已切换。</p>
        </div>
      )}
      {today && <RecoveryBanner today={today} />}
      {statsError && !today && (
        <div className="card" style={{ background: '#fef3f2', borderColor: '#fecdca' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <b style={{ color: '#b42318' }}>今日进度加载失败</b>
              <p className="muted" style={{ margin: '4px 0 0' }}>{statsError}</p>
            </div>
            <button className="btn ghost" onClick={() => setReloadKey((k) => k + 1)}>重试</button>
          </div>
        </div>
      )}
      {due && due.stats.due > 0 && (
        <div className="card" style={{ background: '#fff7ed', borderColor: '#fed7aa' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <b style={{ color: '#b45309' }}>待复习错词 {due.stats.due} 个</b>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                {due.stats.overdue > 0 ? `其中 ${due.stats.overdue} 个已逾期 · ` : ''}
                按 1 / 3 / 7 天间隔复习，今天过一遍记得更牢。
              </p>
            </div>
            <Link to="/review"><button className="btn">去复习</button></Link>
          </div>
        </div>
      )}
      {plan.stages.map((s) => (
        <TaskCard
          key={s.id}
          type={s.type}
          status={s.status as StageStatus}
          progressText={
            s.status === StageStatus.ACTIVE
              ? today
                ? `今日 ${today.progress} / ${today.goal} ${UNIT_LABEL[today.unit]}`
                : statsError
                  ? '今日进度暂不可用'
                  : '今日进度加载中…'
              : ''
          }
          unlockHint={s.unlockHint}
        />
      ))}
      {today && (
        <p className="muted" style={{ padding: '0 4px' }}>
          {today.checkedIn ? `今日已打卡 · 连续 ${today.streakDays} 天` : `今日尚未达标 · 连续打卡 ${today.streakDays} 天`}
        </p>
      )}
    </div>
  );
}
