import { useEffect, useRef, useState } from 'react';
import type { AchievementsDto, ActivityDto, CheckinDayDto, ImportResultDto, PlanSummaryDto, TodayTaskDto, WeeklyReportDto } from '@ladder/shared';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { CheckinCalendar } from '../../components/CheckinCalendar';
import { RecoveryBanner } from '../../components/RecoveryBanner';

/** E2 数据导出：全量 JSON 备份 + 单表 CSV（走 fetch 取 Blob，保留登录态） */
function ExportCard() {
  const token = useAuthStore((s) => s.token);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // F3 数据导入恢复
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [restored, setRestored] = useState<ImportResultDto | null>(null);

  const importFile = async (file: File) => {
    setBusy('import'); setError(''); setRestored(null);
    try {
      let payload: unknown;
      try {
        payload = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
      } catch {
        throw new Error('文件不是合法的 JSON 备份');
      }
      const r = await api<ImportResultDto>('/stats/import', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setRestored(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败');
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const download = async (path: string, filename: string) => {
    setBusy(path); setError('');
    try {
      const res = await fetch(`/api${path}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`导出失败（${res.status}）`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
    } finally {
      setBusy('');
    }
  };

  const date = new Date().toISOString().slice(0, 10);
  return (
    <div className="card">
      <h2>数据导出与导入</h2>
      <p className="muted">导出学习数据用于备份或自查；CSV 带 UTF-8 BOM，可直接用 Excel 打开。换设备或误删后可导入 JSON 备份恢复打卡、错词、收藏与标记。</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" disabled={!!busy} onClick={() => void download('/stats/export', `ladder-backup-${date}.json`)}>
          全量备份（JSON）
        </button>
        <button className="btn ghost" disabled={!!busy} onClick={() => void download('/stats/export/csv?entity=dictation', `ladder-dictation-${date}.csv`)}>
          听写记录（CSV）
        </button>
        <button className="btn ghost" disabled={!!busy} onClick={() => void download('/stats/export/csv?entity=wrong-words', `ladder-wrong-words-${date}.csv`)}>
          错词本（CSV）
        </button>
        <button className="btn ghost" disabled={!!busy} onClick={() => void download('/stats/export/csv?entity=checkins', `ladder-checkins-${date}.csv`)}>
          打卡记录（CSV）
        </button>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); }}
        />
        <button className="btn ghost" disabled={!!busy} onClick={() => fileRef.current?.click()}>
          导入恢复（JSON 备份）
        </button>
      </div>
      {busy && <p className="muted">{busy === 'import' ? '正在导入…' : '正在导出…'}</p>}
      {restored && (
        <p className="muted">
          导入完成：打卡 {restored.checkins} · 错词 {restored.wrongWords} · 收藏 {restored.favorites} · 没听懂 {restored.confusedMarks}
          {restored.skipped > 0 ? ` · 跳过重复或无效 ${restored.skipped} 条` : ''}
        </p>
      )}
      {error && <p style={{ color: '#b42318' }}>{error}</p>}
    </div>
  );
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const STAGE_LABEL: Record<string, string> = { LISTEN: '阶段一 沉浸听力', DICTATE: '阶段二 逐句听写', SPEAK: '阶段三 口语输出' };

/** A3 周报：7 日听时长柱状图 + 本周 KPI + 薄弱词 Top5 + 阶段进度 */
function WeeklyCard({ report }: { report: WeeklyReportDto }) {
  const max = Math.max(60, ...report.days.map((d) => d.listenMin));
  return (
    <div className="card">
      <h2>本周学习报告</h2>
      <p className="muted">
        {report.startDate} 至 {report.endDate} · 目标每天 60 分钟
      </p>
      <div className="week-chart">
        {report.days.map((d) => (
          <div className="week-col" key={d.date}>
            <div
              className={d.listenMin === 0 ? 'week-bar zero' : 'week-bar'}
              style={{ height: `${Math.max(3, (d.listenMin / max) * 100)}%` }}
              title={`${d.date}：${d.listenMin} 分钟${d.dictationCount ? `，听写 ${d.dictationCount} 句` : ''}`}
            />
            <div className="week-label">{WEEKDAYS[new Date(d.date + 'T00:00:00').getDay()]}</div>
          </div>
        ))}
      </div>
      <div className="week-grid" style={{ marginTop: 16 }}>
        <div className="week-kpi">
          <b>{report.totals.listenMin}</b>
          <span className="muted">有效听时长（分钟）</span>
        </div>
        <div className="week-kpi">
          <b>{report.totals.checkedDays} / 7</b>
          <span className="muted">打卡天数</span>
        </div>
        <div className="week-kpi">
          <b>{report.totals.dictationCount}</b>
          <span className="muted">
            听写句数{report.totals.dictationCount > 0 && ` · 平均 ${Math.round(report.totals.dictationAvgRate * 100)}%`}
          </span>
        </div>
        <div className="week-kpi">
          <b>{report.totals.speakingCount}</b>
          <span className="muted">口语录音（段）</span>
        </div>
      </div>
      {report.stage && (
        <p className="muted" style={{ marginTop: 12 }}>
          当前：{STAGE_LABEL[report.stage.type] ?? report.stage.type}
          {report.stage.dayIndex > 0 && ` · 第 ${report.stage.dayIndex} / ${report.stage.plannedDays} 天`}
        </p>
      )}
      <div style={{ marginTop: 12 }}>
        <div className="muted" style={{ marginBottom: 6 }}>本周高频错词</div>
        {report.weakWords.length === 0 ? (
          <p className="muted">本周没有新增错词，保持住。</p>
        ) : (
          <div className="row" style={{ gap: 6 }}>
            {report.weakWords.map((w) => (
              <span className="tag warn" key={w.word}>{w.word} ×{w.count}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** I3 近 30 天学习热力图（与 GET /stats/heatmap 出参一致） */
interface HeatmapDay {
  date: string;
  listenMin: number;
  dictationCount: number;
  speakingCount: number;
  checkedIn: boolean;
  level: number;
}
interface HeatmapDto {
  startDate: string;
  endDate: string;
  days: HeatmapDay[];
  totals: {
    activeDays: number;
    checkedDays: number;
    listenMin: number;
    dictationCount: number;
    speakingCount: number;
  };
}
const HEAT_COLORS = ['#eef1f6', '#ffe8cc', '#ffd8a8', '#f79009', '#b45309'];

function HeatmapCard({ data }: { data: HeatmapDto }) {
  return (
    <div className="card">
      <h2>近 30 天学习热力图</h2>
      <p className="muted">
        {data.startDate} 至 {data.endDate} · 活跃 {data.totals.activeDays} 天 · 打卡 {data.totals.checkedDays} 天
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
        {data.days.map((d) => (
          <div
            key={d.date}
            title={`${d.date}：听力 ${d.listenMin} 分钟 · 听写 ${d.dictationCount} 句 · 口语 ${d.speakingCount} 段${d.checkedIn ? ' · 已打卡' : ''}`}
            style={{ aspectRatio: '1', borderRadius: 4, background: HEAT_COLORS[d.level] ?? HEAT_COLORS[0] }}
          />
        ))}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 10, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>少</span>
        {HEAT_COLORS.map((c) => (
          <span key={c} style={{ width: 14, height: 14, borderRadius: 3, background: c, display: 'inline-block' }} />
        ))}
        <span className="muted" style={{ fontSize: 12 }}>多</span>
      </div>
      <p className="muted" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
        合计：听力 {data.totals.listenMin} 分钟 · 听写 {data.totals.dictationCount} 句 · 口语 {data.totals.speakingCount} 段
      </p>
    </div>
  );
}

/** C2 成就徽章：解锁状态 + 进度条 */
function AchievementsCard({ data }: { data: AchievementsDto }) {
  return (
    <div className="card">
      <h2>成就徽章</h2>
      <p className="muted">已解锁 {data.unlockedCount} / {data.total} 枚 · 学习数据实时统计</p>
      <div className="ach-grid">
        {data.items.map((a) => {
          const pct = Math.min(100, Math.round((a.progress / a.target) * 100));
          return (
            <div className={a.unlocked ? 'ach-item on' : 'ach-item'} key={a.key}>
              <div className="ach-badge">{a.unlocked ? '✓' : `${pct}%`}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{a.title}</b>
                <div className="muted" style={{ fontSize: 12 }}>{a.description}</div>
                <div className="ach-bar"><div style={{ width: `${pct}%` }} /></div>
                <div className="muted" style={{ fontSize: 12 }}>{a.progress} / {a.target}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** K3 学习动态：事件类型 → 标记字与配色 */
const ACTIVITY_META: Record<string, { mark: string; color: string }> = {
  listen: { mark: '听', color: '#0ba5ec' },
  dictation: { mark: '写', color: '#f79009' },
  review: { mark: '复', color: '#7a5af8' },
  speaking: { mark: '说', color: '#12b76a' },
  checkin: { mark: '签', color: '#b42318' },
};

/** K3 最近学习动态：听力/听写/复习/口语/打卡统一时间线 */
function ActivityCard({ data }: { data: ActivityDto }) {
  return (
    <div className="card">
      <h2>最近学习动态</h2>
      <p className="muted">{data.startDate} 至 {data.endDate} · 共 {data.events.length} 条</p>
      {data.events.length === 0 ? (
        <p className="muted">这段时间还没有学习记录，去听力或听写练一练吧。</p>
      ) : (
        data.events.map((e, i) => {
          const meta = ACTIVITY_META[e.type] ?? { mark: '·', color: '#98a2b3' };
          const t = new Date(e.createdAt);
          const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
          return (
            <div
              key={`${e.type}-${e.createdAt}-${i}`}
              style={{
                display: 'flex', gap: 10, padding: '8px 0',
                borderBottom: i === data.events.length - 1 ? 'none' : '1px solid #eef1f6',
              }}
            >
              <div style={{
                width: 26, height: 26, borderRadius: 13, background: meta.color, color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, flexShrink: 0,
              }}>
                {meta.mark}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14 }}>{e.label}</div>
                <div className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.detail}
                </div>
              </div>
              <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>
                {e.date.slice(5)}{e.type === 'checkin' ? '' : ` ${hhmm}`}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

/** FR-07 统计页：周报 + 成就徽章 + 打卡日历 + 累计统计 + 断签恢复挑战横幅（SR-03）。 */
export function StatsPage() {
  const [days, setDays] = useState<CheckinDayDto[]>([]);
  const [summary, setSummary] = useState<PlanSummaryDto | null>(null);
  const [today, setToday] = useState<TodayTaskDto | null>(null);
  const [weekly, setWeekly] = useState<WeeklyReportDto | null>(null);
  const [achievements, setAchievements] = useState<AchievementsDto | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapDto | null>(null);
  const [activity, setActivity] = useState<ActivityDto | null>(null);
  /** 部分统计接口失败时显式提示，避免沉默展示「暂无数据」造成误解 */
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  /** P2-12：7 个接口各自返回即插入卡片会造成连环布局偏移（CLS 0.76），
   *  等全部 settle 后一次性渲染；重试时不重置，保持已有内容静默刷新 */
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const month = new Date().toISOString().slice(0, 7);
    setLoadError('');
    const tasks = [
      api<CheckinDayDto[]>(`/stats/calendar?month=${month}`).then(setDays),
      api<PlanSummaryDto>('/stats/summary').then(setSummary),
      api<TodayTaskDto>('/stats/today').then(setToday),
      api<WeeklyReportDto>('/stats/weekly').then(setWeekly),
      api<AchievementsDto>('/stats/achievements').then(setAchievements),
      api<HeatmapDto>('/stats/heatmap?days=30').then(setHeatmap),
      api<ActivityDto>('/stats/activity?days=7').then(setActivity),
    ];
    void Promise.allSettled(tasks).then((rs) => {
      const failed = rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed.length) {
        const first = failed[0].reason;
        const detail = first instanceof Error ? first.message : '网络异常';
        setLoadError(`${failed.length} 项统计加载失败：${detail}`);
      }
      setLoaded(true);
    });
  }, [reloadKey]);

  if (!loaded) {
    return (
      <div className="card" aria-busy="true" aria-live="polite">
        <h2>学习统计</h2>
        <p className="muted">正在加载统计数据…</p>
      </div>
    );
  }

  return (
    <div>
      {today && <RecoveryBanner today={today} />}
      {loadError && (
        <div className="card" style={{ background: '#fef3f2', borderColor: '#fecdca' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <b style={{ color: '#b42318' }}>统计加载不完整</b>
              <p className="muted" style={{ margin: '4px 0 0' }}>{loadError}</p>
            </div>
            <button className="btn ghost" onClick={() => setReloadKey((k) => k + 1)}>重试</button>
          </div>
        </div>
      )}
      {weekly && <WeeklyCard report={weekly} />}
      {heatmap && <HeatmapCard data={heatmap} />}
      {activity && <ActivityCard data={activity} />}
      {achievements && <AchievementsCard data={achievements} />}
      <ExportCard />
      <div className="card">
        <h2>打卡日历</h2>
        <CheckinCalendar days={days} />
      </div>
      <div className="card">
        <h2>累计统计</h2>
        {summary ? (
          <ul>
            <li>累计有效听时长：{summary.totalListenMin} 分钟</li>
            <li>听写：{summary.dictationSentenceCount} 句 · 平均正确率 {Math.round(summary.dictationAvgCorrectRate * 100)}%</li>
            <li>口语录音：{summary.speakingRecordCount} 段</li>
          </ul>
        ) : (
          <p className="muted">
            {loadError ? '累计统计暂不可用，点击上方「重试」重新加载。' : '完成第一次 60 分钟听力后，这里会出现你的曲线。'}
          </p>
        )}
      </div>
    </div>
  );
}
