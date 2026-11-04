import type { CheckinDayDto } from '@ladder/shared';

/** 打卡日历（FR-07；断签日灰色 + 恢复挑战入口由 StatsPage 提供） */
export function CheckinCalendar({ days }: { days: CheckinDayDto[] }) {
  const doneSet = new Set(days.filter((d) => d.done).map((d) => d.date));
  const today = new Date();
  const cells: Array<{ key: string; label: number; state: 'done' | 'miss' | 'future' }> = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    cells.push({ key, label: d.getDate(), state: doneSet.has(key) ? 'done' : 'miss' });
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
      {cells.map((c) => (
        <div
          key={c.key}
          title={c.key}
          style={{
            textAlign: 'center', padding: '6px 0', borderRadius: 6, fontSize: 12,
            background: c.state === 'done' ? '#e6f4ea' : '#eef1f5',
            color: c.state === 'done' ? '#067647' : '#5b6472',
          }}
        >
          {c.label}
        </div>
      ))}
    </div>
  );
}
