import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PlanSummaryDto } from '@ladder/shared';
import { api } from '../../api/client';

/** FR-06 计划完成页：三项累计数据 + 下一轮计划建议。 */
export function PlanCompletePage() {
  const [summary, setSummary] = useState<PlanSummaryDto | null>(null);
  /** 统计加载失败：显式提示并可重试，避免只显示标题像「没有数据」 */
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setError('');
    api<PlanSummaryDto>('/stats/summary')
      .then(setSummary)
      .catch((e) => setError(e instanceof Error ? e.message : '统计加载失败'));
  }, [reloadKey]);

  return (
    <div className="card">
      <h2>🎉 计划完成</h2>
      {error && !summary && (
        <div className="row" style={{ alignItems: 'center', gap: 8 }}>
          <p style={{ color: '#b42318', margin: 0 }}>累计统计加载失败：{error}</p>
          <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }} onClick={() => setReloadKey((k) => k + 1)}>
            重试
          </button>
        </div>
      )}
      {summary && (
        <ul>
          <li>累计有效听时长：{summary.totalListenMin} 分钟</li>
          <li>听写 {summary.dictationSentenceCount} 句 · 平均正确率 {Math.round(summary.dictationAvgCorrectRate * 100)}%</li>
          <li>口语录音 {summary.speakingRecordCount} 段</li>
        </ul>
      )}
      <p className="muted">下一轮建议：同级别更换内容包，或通过分级小测后升级级别。</p>
      <Link to="/onboarding"><button className="btn">开始下一轮计划</button></Link>
    </div>
  );
}
