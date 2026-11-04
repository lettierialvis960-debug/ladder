/**
 * 推送事件处理（由 vite-plugin-pwa 的 workbox.importScripts 注入到生成的 Service Worker）。
 * push 事件 → 显示系统通知，并 postMessage 给页面用于端到端验证/状态展示。
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Ladder', body: (event.data && event.data.text()) || '' };
  }
  const title = data.title || 'Ladder 学习提醒';
  const body = data.body || '该去完成今天的任务啦';
  const payload = { title, body, url: data.url || '/' };

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body,
        tag: 'ladder-reminder',
        renotify: true,
        data: payload,
      });
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach((c) => c.postMessage({ type: 'push-received', data: payload }));
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) {
        if (c.url.startsWith(self.location.origin)) return c.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
