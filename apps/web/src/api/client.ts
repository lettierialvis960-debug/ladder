import { useAuthStore } from '../stores/auth';

// dev 下由 Vite 代理 /api → 3000；生产构建（npx serve 等静态托管）直连后端完整地址。
// 所有需要裸 fetch（登录/导出 Blob）的地方也复用该基地址，避免相对路径在无代理环境下失效。
export const API_BASE = import.meta.env.DEV ? '/api' : 'http://localhost:3000/api';

/** 提前续期窗口：access token 剩余有效期 < 24h 时自动 refresh（而非等真过期才被动续） */
export const PROACTIVE_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 续期也失败时写入登录页的提示文案 */
export const EXPIRED_NOTICE = '登录已过期，请重新登录';

/** 模块级去重：并发请求共享同一个 refresh Promise，不会打爆端点 */
let refreshPromise: Promise<string | null> | null = null;

export function decodeExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const pad = 4 - (parts[1].length % 4);
    const body = JSON.parse(
      decodeURIComponent(
        atob(parts[1].replace(/-/g, '+').replace(/_/g, '/') + (pad === 4 ? '' : '='.repeat(pad))),
      ),
    );
    return typeof body.exp === 'number' ? body.exp : null;
  } catch {
    return null;
  }
}

export async function tryRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  const token = useAuthStore.getState().token;
  if (!token) return null;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      useAuthStore.getState().setToken(body.accessToken);
      return body.accessToken as string;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

/** 主动续期：发请求前检查 token 是否快过期，提前 refresh */
async function ensureFresh(token: string | null): Promise<string | null> {
  if (!token) return null;
  const exp = decodeExp(token);
  if (exp == null) return token;
  const remaining = exp * 1000 - Date.now();
  if (remaining > PROACTIVE_REFRESH_WINDOW_MS) return token;
  const refreshed = await tryRefresh();
  return refreshed ?? token;
}

/** fetch 封装：JWT 注入 + 统一错误。
 *  - 快过期主动续期（< 24h）
 *  - 真 401 时再试一次 refresh + 重试
 *  - 续期失败才清空登录态（SR-05）
 */
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (path === '/auth/refresh' || path === '/auth/login' || path === '/auth/register') {
    const token = useAuthStore.getState().token;
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message ?? `请求失败（${res.status}）`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  let token = await ensureFresh(useAuthStore.getState().token);
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (res.status === 401) {
    // 被动续期兜底：token 真过期后再试一次 refresh
    const newToken = await tryRefresh();
    if (newToken) {
      const retry = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${newToken}`,
          ...options.headers,
        },
      });
      if (retry.status === 401) {
        useAuthStore.getState().logout(EXPIRED_NOTICE);
        throw new Error('登录已过期');
      }
      if (!retry.ok) {
        const body = await retry.json().catch(() => ({}));
        throw new Error(body.message ?? `请求失败（${retry.status}）`);
      }
      const text = await retry.text();
      return (text ? JSON.parse(text) : null) as T;
    }
    useAuthStore.getState().logout(EXPIRED_NOTICE);
    throw new Error('登录已过期');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `请求失败（${res.status}）`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** 录音等二进制上传（不走 JSON）。同样支持主动 + 被动续期。 */
export async function uploadFile(path: string, file: Blob): Promise<{ url: string }> {
  let token = await ensureFresh(useAuthStore.getState().token);
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (res.status === 401) {
    const newToken = await tryRefresh();
    if (newToken) {
      const retry = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${newToken}` },
        body: form,
      });
      if (retry.ok) return retry.json();
    }
    useAuthStore.getState().logout(EXPIRED_NOTICE);
    throw new Error('上传失败：登录已过期');
  }
  if (!res.ok) throw new Error('上传失败');
  return res.json();
}
