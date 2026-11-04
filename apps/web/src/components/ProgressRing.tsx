interface ProgressRingProps {
  value: number; // 0~1
  label: string;
  sub?: string;
}

/** 今日目标进度环（FR-03 演示 A 的正式组件） */
export function ProgressRing({ value, label, sub }: ProgressRingProps) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const pct = Math.min(Math.max(value, 0), 1);
  return (
    <div className="row">
      <svg width="110" height="110" viewBox="0 0 110 110">
        <circle cx="55" cy="55" r={r} fill="none" stroke="#eef1f5" strokeWidth="10" />
        <circle
          cx="55" cy="55" r={r} fill="none" stroke="#1a56db" strokeWidth="10"
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
          transform="rotate(-90 55 55)"
        />
      </svg>
      <div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>{label}</div>
        {sub && <div className="muted">{sub}</div>}
      </div>
    </div>
  );
}
