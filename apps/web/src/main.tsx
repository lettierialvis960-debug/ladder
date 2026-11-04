import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import './styles.css';

// PWA: 注册 vite-plugin-pwa 生成的 Service Worker
// devOptions.enabled=true 时 dev 模式也能注册（便于端到端验证推送）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const { registerSW } = await import('virtual:pwa-register');
      registerSW({
        immediate: true,
        onNeedRefresh() {
          // 新 SW 就绪 → 刷新即应用（生产期可改弹 prompt 让用户确认）
          location.reload();
        },
        onOfflineReady() {
          console.info('[PWA] 离线缓存就绪');
        },
      });
    } catch (e) {
      console.warn('[PWA] registerSW 失败', e);
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
