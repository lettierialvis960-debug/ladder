/**
 * P1 提醒推送兜底：本地提醒调度器。
 * Web Push 依赖浏览器推送服务（Chrome→FCM），部分网络/环境不可用；
 * 本地模式在应用打开期间按 reminderTime 触发系统通知（无需推送服务）。
 * 已订阅 Web Push 的设备跳过本地提醒，避免双份。
 */
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { todayLocal } from './date';

const KEY = 'ladder.reminder.v1';

export interface LocalReminder {
  mode: 'local';
  enabled: boolean;
  time: string; // HH:mm 本地时间
  lastDate?: string; // 当天已提醒过则不再触发
}

export function readLocalReminder(): LocalReminder | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as LocalReminder;
    return v.mode === 'local' ? v : null;
  } catch {
    return null;
  }
}

export function writeLocalReminder(v: LocalReminder) {
  localStorage.setItem(KEY, JSON.stringify(v));
}

export function clearLocalReminder() {
  localStorage.removeItem(KEY);
}

let timer: number | undefined;

/** 应用启动时调用（App 挂载后），每 30s 检查一次是否到点 */
export function initReminderScheduler() {
  if (timer !== undefined) return;
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
  timer = window.setInterval(() => void tickReminder(), 30_000);
  void tickReminder();
}

async function tickReminder() {
  const s = readLocalReminder();
  if (!s?.enabled) return;
  if (!useAuthStore.getState().token) return;

  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (hhmm < s.time) return;
  const today = todayLocal();
  if (s.lastDate === today) return;

  try {
    // 已有 Web Push 订阅 → 服务器负责提醒，本地不再触发
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && (await reg.pushManager.getSubscription())) {
      writeLocalReminder({ ...s, lastDate: today });
      return;
    }
    const t = await api<{ checkedIn: boolean }>('/stats/today');
    if (t.checkedIn) {
      writeLocalReminder({ ...s, lastDate: today });
      return;
    }
    const ready = await navigator.serviceWorker.ready;
    await ready.showNotification('Ladder 学习提醒', {
      body: '今天的任务还没完成，去练一会儿吧！',
      tag: 'ladder-reminder',
    });
    writeLocalReminder({ ...s, lastDate: today });
    window.dispatchEvent(new CustomEvent('ladder-reminder-fired'));
  } catch {
    /* 未登录/网络失败/权限未授予：静默跳过，下个周期重试 */
  }
}
