import { Link } from 'react-router-dom';
import { StageStatus, StageType } from '@ladder/shared';

const STAGE_META: Record<StageType, { title: string; path: string }> = {
  [StageType.LISTEN]: { title: '阶段一 · 沉浸听力', path: '/listen' },
  [StageType.DICTATE]: { title: '阶段二 · 逐句听写', path: '/dictation' },
  [StageType.SPEAK]: { title: '阶段三 · 口语输出', path: '/speaking' },
};

interface TaskCardProps {
  type: StageType;
  status: StageStatus;
  progressText: string;   // 如 "32 / 60 分钟"
  unlockHint?: string | null;
}

/** 今日页三阶段任务卡（FR-03/04/05 统一入口） */
export function TaskCard({ type, status, progressText, unlockHint }: TaskCardProps) {
  const meta = STAGE_META[type];
  const tagClass = status === StageStatus.ACTIVE ? 'tag' : status === StageStatus.DONE ? 'tag done' : 'tag locked';
  const tagText = status === StageStatus.ACTIVE ? '进行中' : status === StageStatus.DONE ? '已完成' : status === StageStatus.SKIPPED ? '已提前切换' : '未解锁';
  return (
    <div className="card">
      <h2>{meta.title} <span className={tagClass}>{tagText}</span></h2>
      <div className="muted">{status === StageStatus.LOCKED ? unlockHint ?? '' : progressText}</div>
      {status === StageStatus.ACTIVE && (
        <div className="row"><Link to={meta.path}><button className="btn">开始今日任务</button></Link></div>
      )}
    </div>
  );
}
