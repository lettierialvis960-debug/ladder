import { Link } from 'react-router-dom';
import { StageType } from '@ladder/shared';
import type { TodayTaskDto } from '@ladder/shared';

const TASK_PATH: Record<StageType, string> = {
  [StageType.LISTEN]: '/listen',
  [StageType.DICTATE]: '/dictation',
  [StageType.SPEAK]: '/speaking',
};

/** SR-03 断签恢复挑战横幅：BROKEN 提示从中断处继续；RECOVERING 展示挑战进度。 */
export function RecoveryBanner({ today }: { today: TodayTaskDto }) {
  const { recovery, streakDays, stageType } = today;
  // SW 缓存的旧响应可能不含 recovery 字段，直接不渲染
  if (!recovery) return null;
  if (recovery.state === 'BROKEN') {
    return (
      <div className="card banner banner-warn">
        <h2>恢复挑战</h2>
        <p>
          你已中断 <strong>{recovery.breakDays}</strong> 天。别担心，计划进度保留，不必重新开始——
          从今天继续，连续打卡 <strong>{recovery.targetDays}</strong> 天即可完成恢复挑战。
        </p>
        <Link to={TASK_PATH[stageType]}><button className="btn">开始恢复挑战</button></Link>
      </div>
    );
  }
  if (recovery.state === 'RECOVERING') {
    return (
      <div className="card banner banner-ok">
        <h2>恢复挑战进行中</h2>
        <p>
          已连续打卡 <strong>{streakDays} / {recovery.targetDays}</strong> 天，
          再坚持 {recovery.targetDays - streakDays} 天完成挑战！
        </p>
      </div>
    );
  }
  return null;
}
