/**
 * P1 离线下载核心层。
 * 用 idb-keyval 把音频 Blob 持久化到 IndexedDB（key = 原始相对路径），
 * 播放时经 getPlayableUrl 取 objectURL，未缓存则回源网络 —— 实现 Cache-First。
 * 注意：Service Worker 运行时缓存只管「在线时的二次加载加速」，IndexedDB 才能跨会话离线回听。
 */
import { createStore, del, get, keys, set } from 'idb-keyval';
import { api } from '../api/client';

/** 内存中已创建的 objectURL 注册表：key = 原始路径，value = objectURL（避免重复 createObjectURL） */
const objectUrlRegistry = new Map<string, string>();

/** 下载单个 URL 为 Blob 并入库。 */
export async function downloadToOffline(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败（${res.status}）: ${url}`);
  const blob = await res.blob();
  await set(url, blob);
}

/** 判断某 URL 是否已离线缓存。 */
export async function isCached(url: string): Promise<boolean> {
  return (await get(url)) !== undefined;
}

/** 列出所有已缓存的原始路径。 */
export async function listCachedUrls(): Promise<string[]> {
  const all = await keys();
  return all.filter((k): k is string => typeof k === 'string');
}

/** 估算离线缓存总字节数。 */
export async function offlineBytes(): Promise<number> {
  const urls = await listCachedUrls();
  let total = 0;
  for (const u of urls) {
    const b = await get<Blob>(u);
    if (b) total += b.size;
  }
  return total;
}

/** 删除指定 URL 的缓存（并释放其 objectURL）。 */
export async function removeOffline(url: string): Promise<void> {
  const objUrl = objectUrlRegistry.get(url);
  if (objUrl) { URL.revokeObjectURL(objUrl); objectUrlRegistry.delete(url); }
  await del(url);
}

/** 按前缀批量删除（用于删除整个内容包）。 */
export async function removeOfflineByPrefix(prefix: string): Promise<number> {
  const urls = await listCachedUrls();
  let n = 0;
  for (const u of urls) {
    if (u.startsWith(prefix)) { await removeOffline(u); n++; }
  }
  return n;
}

/**
 * 取可播放地址：已缓存 → objectURL；未缓存 → 原路径（回源网络）。
 * 这是 <audio> 的唯一事实源，保证离线也能播已下载材料。
 */
export async function getPlayableUrl(url: string): Promise<string> {
  const cached = objectUrlRegistry.get(url);
  if (cached) return cached;
  const blob = await get<Blob>(url);
  if (blob) {
    const objUrl = URL.createObjectURL(blob);
    objectUrlRegistry.set(url, objUrl);
    return objUrl;
  }
  return url;
}

/* ================= 元数据离线层（P1-4） =================
 * 清单/句子/计划等 JSON 元数据存独立 idb store（与音频 blob 隔离，不污染占用统计）。
 * apiGet = 网络优先：成功则刷新缓存；网络失败回退缓存；两者都没有才抛错。
 * 音频要用户显式下载，元数据则在「浏览过 / 整包下载时预热」自动可用。
 */
const metaStore = createStore('ladder-meta', 'meta');

export async function setMeta(key: string, data: unknown): Promise<void> {
  await set(key, data, metaStore);
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return get<T>(key, metaStore);
}

/** 清空全部元数据缓存（退出登录/换账号时调用，防串号）。 */
export async function clearMeta(): Promise<void> {
  const all = await keys(metaStore);
  for (const k of all) await del(k, metaStore);
}

/**
 * 清空 SW 运行时缓存中的 API 数据（登出/换账号时调用，防串号）。
 * P2-15 之后 GET API 响应会被 SW 缓存在 'api-data'，换账号必须清掉，
 * 否则离线时会展示上一个用户的统计/学习数据。
 */
export async function clearApiDataCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  await caches.delete('api-data');
}

/** GET 请求 + 离线兜底。仅用于幂等 GET 接口（清单/句子/计划）。 */
export async function apiGet<T>(path: string): Promise<T> {
  try {
    const data = await api<T>(path);
    void setMeta(path, data).catch(() => {});
    return data;
  } catch (e) {
    const cached = await getMeta<T>(path).catch(() => undefined);
    if (cached !== undefined) return cached;
    throw e;
  }
}

/**
 * 预热全部页面级懒加载 chunk，使「未访问过的路由」断网时也能打开。
 * P2-11 把页面 chunk 排除出预缓存（安装流量小），改为整包下载时按需拉取一次，
 * 由 SW 的 page-chunks（CacheFirst）缓存；构建产物 manifest 提供 chunk 清单。
 * 返回成功写入缓存的文件数；dev 环境无 manifest 时返回 0。
 */
export async function warmRouteChunks(): Promise<number> {
  if (typeof window === 'undefined') return 0;
  // 等待 SW 就绪（clientsClaim 会立即接管当前页），否则 fetch 不经过 SW，缓存不会写入
  if (navigator.serviceWorker) {
    await Promise.race([
      navigator.serviceWorker.ready.catch(() => undefined),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  }
  let manifest: Record<string, { file?: string; isDynamicEntry?: boolean }>;
  try {
    const res = await fetch('/.vite/manifest.json', { cache: 'no-cache' });
    if (!res.ok) return 0;
    manifest = (await res.json()) as typeof manifest;
  } catch {
    return 0;
  }
  const files = new Set<string>();
  for (const [key, entry] of Object.entries(manifest)) {
    if (entry?.isDynamicEntry && entry.file) files.add('/' + entry.file.replace(/^\/+/, ''));
  }
  let ok = 0;
  await Promise.all(
    [...files].map(async (url) => {
      try {
        const r = await fetch(url);
        if (r.ok) ok++;
      } catch { /* 单个 chunk 失败不阻塞 */ }
    }),
  );
  return ok;
}
