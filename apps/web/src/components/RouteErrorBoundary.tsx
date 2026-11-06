import { Component, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * 路由级错误边界（P2-14）。
 * 页面 chunk 拉取失败（典型场景：离线且该页面未访问过、代码未进入运行时缓存）
 * 时只替换内容区，App 外壳与底部导航仍然可用，用户可退回已缓存页面继续学习。
 */
export class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;

    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;

    return (
      <div className="card" role="alert">
        <h2>这个页面暂时打不开</h2>
        <p className="muted">
          {offline
            ? '当前处于离线状态，而这个页面的代码还没有缓存到本机。可以先回到打开过的页面继续学习，联网后本页会自动可用。'
            : '页面代码加载失败，可能是网络波动或版本刚更新。重试一次通常就能打开。'}
        </p>
        <div className="row">
          <button className="btn" onClick={() => window.location.reload()}>重试</button>
          <Link to="/"><button className="btn ghost">返回今日</button></Link>
        </div>
      </div>
    );
  }
}
