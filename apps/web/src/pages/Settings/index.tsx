import { useCallback, useEffect, useState } from 'react';
import type { DailyGoalsDto } from '@ladder/shared';
import { api } from '../../api/client';
import { pushSupported, subscribePush, unsubscribePush, type PushSupport } from '../../lib/push';
import { clearLocalReminder, readLocalReminder, writeLocalReminder } from '../../lib/reminder';

interface PushSettings {
  supported: boolean;
  subscribed: boolean;
  reminderEnabled: boolean;
  reminderTime: string;
}

type Mode = 'none' | 'push' | 'local';

/**
 * P1 提醒推送设置页（/settings，头部入口）。
 * 双模式：Web Push（服务器推送，应用未打开也可送达）优先；
 * 浏览器推送服务不可用时自动降级为本地提醒（应用打开期间按设定时间触发系统通知）。
 */
export function SettingsPage() {
  const [mode, setMode] = useState<Mode>('none');
  const [reminderTime, setReminderTime] = useState('20:00');
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [lastPush, setLastPush] = useState<{ title: string; body: string } | null>(null);
  // G2 每日目标
  const [goals, setGoals] = useState<DailyGoalsDto>({ listenMin: 60, dictationPassages: 1, readSentences: 10 });
  const [goalsBusy, setGoalsBusy] = useState(false);
  const [goalsMsg, setGoalsMsg] = useState('');

  const loadGoals = useCallback(async () => {
    try {
      setGoals(await api<DailyGoalsDto>('/stats/goals'));
    } catch { /* 未登录时保持默认值 */ }
  }, []);
  useEffect(() => { void loadGoals(); }, [loadGoals]);

  const saveGoals = async () => {
    setGoalsBusy(true); setGoalsMsg('');
    try {
      const saved = await api<DailyGoalsDto>('/stats/goals', {
        method: 'PUT',
        body: JSON.stringify(goals),
      });
      setGoals(saved);
      setGoalsMsg('已保存，今日页与自动打卡将按新目标计算');
    } catch (e) {
      setGoalsMsg(e instanceof Error ? e.message : '保存失败');
    } finally {
      setGoalsBusy(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const s = await api<PushSettings>('/push/settings');
      if (s.subscribed) {
        setMode('push');
        setReminderTime(s.reminderTime);
        setReminderEnabled(s.reminderEnabled);
        return;
      }
    } catch { /* 未登录等：按本地模式读取 */ }
    const local = readLocalReminder();
    if (local) {
      setMode('local');
      setReminderTime(local.time);
      setReminderEnabled(local.enabled);
    } else {
      setMode('none');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // SW → 页面：收到服务器推送时展示
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'push-received') setLastPush(e.data.data);
    };
    const onFired = () => setLastPush({ title: 'Ladder 学习提醒', body: '今天的任务还没完成，去练一会儿吧！' });
    navigator.serviceWorker.addEventListener('message', onMsg);
    window.addEventListener('ladder-reminder-fired', onFired);
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMsg);
      window.removeEventListener('ladder-reminder-fired', onFired);
    };
  }, []);

  const enable = useCallback(async () => {
    setBusy(true); setMsg('');
    try {
      if (pushSupported()) {
        const r: PushSupport = await subscribePush();
        if (r === 'supported') {
          await api('/push/settings', { method: 'PUT', body: JSON.stringify({ reminderEnabled, reminderTime }) });
          clearLocalReminder();
          setMode('push');
          setMsg('已开启推送提醒（应用未打开也能收到）');
          return;
        }
        if (r === 'denied') {
          setMsg('通知权限被拒绝：请在浏览器地址栏的权限设置中允许「通知」后重试。');
          return;
        }
        // unsupported → 走本地兜底
      }
    } catch {
      // push 服务不可用（如浏览器禁用后台网络/网络受限）→ 走本地兜底
    } finally {
      setBusy(false);
    }
    // 本地提醒兜底
    if (!('serviceWorker' in navigator) || !('Notification' in window)) {
      setMsg('当前浏览器不支持通知。');
      return;
    }
    if (Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') {
        setMsg('通知权限被拒绝：请在浏览器地址栏的权限设置中允许「通知」后重试。');
        return;
      }
    }
    writeLocalReminder({ mode: 'local', enabled: true, time: reminderTime });
    setMode('local');
    setMsg('已开启本地提醒（应用打开期间按设定时间提醒）');
  }, [reminderEnabled, reminderTime]);

  const disable = useCallback(async () => {
    setBusy(true); setMsg('');
    try {
      if (mode === 'push') {
        await unsubscribePush();
      } else {
        clearLocalReminder();
      }
      setMsg('已关闭提醒');
    } finally {
      setBusy(false);
      void load();
    }
  }, [mode, load]);

  const saveSettings = useCallback(async () => {
    setBusy(true); setMsg('');
    try {
      if (mode === 'push') {
        await api('/push/settings', { method: 'PUT', body: JSON.stringify({ reminderEnabled, reminderTime }) });
      } else {
        writeLocalReminder({ mode: 'local', enabled: reminderEnabled, time: reminderTime });
      }
      setMsg('已保存');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
      void load();
    }
  }, [mode, reminderEnabled, reminderTime, load]);

  const sendTest = useCallback(async () => {
    setBusy(true); setMsg('');
    try {
      if (mode === 'push') {
        const r = await api<{ sent: number }>('/push/test', { method: 'POST' });
        setMsg(r.sent > 0 ? '测试通知已发送，请查看系统通知' : '发送失败：没有可用的订阅');
      } else {
        const ready = await navigator.serviceWorker.ready;
        await ready.showNotification('Ladder 测试通知', { body: '本地提醒通道正常。', tag: 'ladder-test' });
        setMsg('本地测试通知已触发，请查看系统通知');
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '发送失败');
    } finally {
      setBusy(false);
    }
  }, [mode]);

  return (
    <div>
      <div className="card">
        <h2>每日目标</h2>
        <p className="muted">目标同时决定自动打卡门槛与今日页进度环；调整后当日即按新目标计算。</p>
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
          <label className="muted">
            听力（分钟/天）
            <br />
            <input
              type="number" min={10} max={240} style={{ width: 90 }}
              value={goals.listenMin}
              onChange={(e) => setGoals({ ...goals, listenMin: Number(e.target.value) })}
            />
          </label>
          <label className="muted">
            听写（篇/天）
            <br />
            <input
              type="number" min={1} max={10} style={{ width: 90 }}
              value={goals.dictationPassages}
              onChange={(e) => setGoals({ ...goals, dictationPassages: Number(e.target.value) })}
            />
          </label>
          <label className="muted">
            跟读（句/天）
            <br />
            <input
              type="number" min={1} max={100} style={{ width: 90 }}
              value={goals.readSentences}
              onChange={(e) => setGoals({ ...goals, readSentences: Number(e.target.value) })}
            />
          </label>
          <button className="btn" disabled={goalsBusy} onClick={() => void saveGoals()}>
            {goalsBusy ? '保存中…' : '保存目标'}
          </button>
        </div>
        {goalsMsg && <p>{goalsMsg}</p>}
      </div>

      <div className="card">
        <h2>学习提醒</h2>
        <p className="muted">
          到设定时间且当日任务未完成时，通过系统通知提醒你来学习（每天最多一次）。
          {mode === 'push' && ' 当前为推送模式：应用未打开也可送达。'}
          {mode === 'local' && ' 当前为本地提醒模式：应用打开期间生效。'}
        </p>

        {mode === 'none' ? (
          <>
            <div className="row">
              <input type="time" aria-label="提醒时间" value={reminderTime} onChange={(e) => setReminderTime(e.target.value)} />
              <button className="btn" disabled={busy} onClick={enable}>
                {busy ? '处理中…' : '开启学习提醒'}
              </button>
            </div>
            <p className="muted">优先启用系统推送；不可用时自动降级为应用内提醒。</p>
          </>
        ) : (
          <>
            <div className="row">
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span>每日提醒</span>
                {/* P2-5 已在 styles.css 定义 .switch 类，这里直接用 */}
                <span className="switch">
                  <input type="checkbox" checked={reminderEnabled} onChange={(e) => setReminderEnabled(e.target.checked)} />
                  <span className="slider" />
                </span>
              </label>
              <input type="time" aria-label="提醒时间" value={reminderTime} onChange={(e) => setReminderTime(e.target.value)} />
              <button className="btn ghost" disabled={busy} onClick={saveSettings}>保存设置</button>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn" disabled={busy} onClick={sendTest}>发送测试通知</button>
              <button className="btn ghost" disabled={busy} onClick={disable}>关闭并解绑</button>
            </div>
            <p className="muted">
              {mode === 'push' ? `已订阅推送 · 提醒时间 ${reminderTime}` : `已开启本地提醒 · 提醒时间 ${reminderTime}`}
            </p>
          </>
        )}

        {msg && <p>{msg}</p>}
        {lastPush && (
          <div style={{ marginTop: 8, padding: '8px 12px', background: '#eef6ee', borderRadius: 8 }}>
            收到推送：<b>{lastPush.title}</b> — {lastPush.body}
          </div>
        )}
      </div>
    </div>
  );
}
