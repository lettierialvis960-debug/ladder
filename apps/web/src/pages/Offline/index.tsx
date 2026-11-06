import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ContentItemDto } from '@ladder/shared';
import { api } from '../../api/client';
import { usePlanStore } from '../../stores/plan';
import { downloadToOffline, listCachedUrls, offlineBytes, removeOffline, apiGet, warmRouteChunks } from '../../lib/offline';

/** 字节数人性化显示 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type PackState = 'none' | 'partial' | 'all';

/**
 * P1 离线下载管理。
 * 按当前计划内容包批量下载「整篇 + 句切片」音频到 IndexedDB，支持删除与占用统计。
 * 在线状态由浏览器 navigator.onLine + online/offline 事件驱动横幅提示。
 */
export function OfflinePage() {
  const { plan, loaded, refresh } = usePlanStore();

  const [items, setItems] = useState<ContentItemDto[]>([]);
  /** 我的自定义材料（听力+听写清单并入，按 id 去重），与官方包一起整包下载 */
  const [mineItems, setMineItems] = useState<ContentItemDto[]>([]);
  const [cachedSet, setCachedSet] = useState<Set<string>>(new Set());
  const [totalBytes, setTotalBytes] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [error, setError] = useState('');

  useEffect(() => { if (!loaded) refresh().catch(() => {}); }, [loaded, refresh]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const refreshCache = useCallback(async () => {
    const urls = await listCachedUrls();
    setCachedSet(new Set(urls));
    setTotalBytes(await offlineBytes());
  }, []);
  useEffect(() => { void refreshCache(); }, [refreshCache]);

  useEffect(() => {
    if (!plan) return;
    apiGet<ContentItemDto[]>(`/content/items?packId=${plan.packId}`)
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'));
    // 自定义材料失败不阻塞官方包
    Promise.all([
      apiGet<ContentItemDto[]>('/content/my-items?list=listening').catch(() => [] as ContentItemDto[]),
      apiGet<ContentItemDto[]>('/content/my-items?list=dictation').catch(() => [] as ContentItemDto[]),
    ]).then(([a, b]) => setMineItems([...new Map([...a, ...b].map((it) => [it.id, it])).values()]));
  }, [plan]);

  /** 全部待缓存材料：官方包 + 我的材料（按 id 去重，自定义包可能同时属于计划） */
  const allItems = (() => {
    const m = new Map([...items, ...mineItems].map((it) => [it.id, it]));
    return [...m.values()];
  })();

  /** 应下载的全部音频 URL（整篇 + 句切片）；句子经 apiGet 拉取，顺带把元数据写进离线缓存 */
  const collectUrls = useCallback(async (): Promise<string[]> => {
    const urls = new Set<string>();
    for (const it of allItems) {
      urls.add(it.audioUrl);
      try {
        const sents = await apiGet<{ audioUrl: string }[]>(`/content/items/${it.id}/sentences`);
        sents.forEach((s) => urls.add(s.audioUrl));
      } catch { /* 单篇失败不阻塞整包 */ }
    }
    return [...urls];
  }, [allItems]);

  /** 预热元数据：让清单/句子/计划在断网时也能从 IndexedDB 读到（与音频一起构成完整离线包） */
  const warmMetadata = useCallback(async () => {
    if (!plan) return;
    const paths = [
      '/plans/current',
      `/content/items?packId=${plan.packId}`,
      `/content/items?packId=${plan.packId}&list=listening`,
      `/content/items?packId=${plan.packId}&list=dictation`,
      '/content/my-items?list=listening',
      '/content/my-items?list=dictation',
    ];
    for (const p of paths) await apiGet(p).catch(() => {});
    for (const it of allItems) {
      await apiGet(`/content/items/${it.id}/sentences`).catch(() => {});
    }
  }, [plan, allItems]);

  const packState: PackState = (() => {
    if (!allItems.length) return 'none';
    const itemUrls = allItems.map((i) => i.audioUrl);
    const cachedItems = itemUrls.filter((u) => cachedSet.has(u)).length;
    if (cachedItems === 0) return 'none';
    return cachedItems === itemUrls.length ? 'all' : 'partial';
  })();

  const downloadAll = useCallback(async () => {
    setBusy(true); setError('');
    try {
      setProgress('同步清单与句子…');
      await warmMetadata();
      const urls = await collectUrls();
      let done = 0;
      for (const u of urls) {
        if (cachedSet.has(u)) { done++; continue; }
        setProgress(`下载中 ${done + 1} / ${urls.length}`);
        await downloadToOffline(u);
        done++;
      }
      // 页面 chunk 预热：未访问过的路由（统计/计划/专练等）离线也能打开
      setProgress('预热页面…');
      await warmRouteChunks();
      await refreshCache();
      setProgress('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '下载失败');
    } finally {
      setBusy(false);
    }
  }, [collectUrls, cachedSet, refreshCache, warmMetadata]);

  const removeAll = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const urls = await collectUrls();
      for (const u of urls) await removeOffline(u);
      await refreshCache();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }, [collectUrls, refreshCache]);

  if (!loaded) return <p className="muted">加载中…</p>;
  if (!plan) {
    return (
      <div className="card">
        <h2>还没有学习计划</h2>
        <p className="muted">先创建计划，离线下载按当前内容包整体缓存。</p>
        <Link to="/onboarding"><button className="btn">创建计划</button></Link>
      </div>
    );
  }

  return (
    <div>
      {!online && (
        <div className="card" style={{ borderColor: '#f5c518', background: '#fffaeb' }}>
          当前处于离线状态：已缓存的内容可正常播放，未缓存的无法加载。
        </div>
      )}

      <div className="card">
        <h2>离线下载</h2>
        <p className="muted">
          把当前内容包与「我的材料」的全部音频（整篇 + 句切片）缓存到本机，离线也能练。已缓存材料在播放页会标注「离线」。
        </p>
        <p className="muted">
          官方包 {items.length} 篇{mineItems.length > 0 && ` + 我的材料 ${mineItems.length} 篇`} ·
          {packState === 'all' ? ' 已全部缓存' : packState === 'partial' ? ' 部分已缓存' : ' 未缓存'}
          {totalBytes > 0 && ` · 本机离线占用约 ${fmtBytes(totalBytes)}`}
        </p>
        <div className="row">
          <button className="btn" disabled={busy || !allItems.length || packState === 'all'} onClick={downloadAll}>
            {packState === 'all' ? '已全部下载' : '下载全部音频'}
          </button>
          {packState !== 'none' && (
            <button className="btn ghost" disabled={busy} onClick={removeAll}>删除离线缓存</button>
          )}
        </div>
        {progress && <p className="muted">{progress}</p>}
        {error && <p style={{ color: '#b42318' }}>{error}</p>}
      </div>
    </div>
  );
}
