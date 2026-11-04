/**
 * P1 提醒推送：浏览器端订阅流程。
 * 请求通知权限 → PushManager 订阅（VAPID 公钥来自后端）→ 上报 /push/subscribe。
 */
import { api } from '../api/client';

export type PushSupport = 'supported' | 'denied' | 'unsupported' | 'error';

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // 显式以 ArrayBuffer 为底层，满足 PushManager 的 BufferSource 类型约束
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** 订阅推送并上报后端。用户拒绝授权返回 'denied'。 */
export async function subscribePush(): Promise<PushSupport> {
  if (!pushSupported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>('/push/vapid-public-key');
  if (!publicKey) throw new Error('服务端未配置 VAPID 密钥');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } };
  if (!json.endpoint || !json.keys) throw new Error('订阅信息不完整');
  await api('/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
  return 'supported';
}

/** 解绑设备：删除后端订阅 + 退订浏览器 PushSubscription */
export async function unsubscribePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const json = sub.toJSON() as { endpoint?: string };
  if (json.endpoint) {
    await api('/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: json.endpoint }),
    }).catch(() => {});
  }
  await sub.unsubscribe();
}
