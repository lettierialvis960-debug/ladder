import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuthStore } from './stores/auth';
import { initReminderScheduler } from './lib/reminder';

type Tab = { to: string; end?: boolean; label: string; icon?: string };

/** 底部导航项：移动端 4 tab + 中间浮动训练按钮；桌面端 8 tab 横向铺开 */
const MOBILE_TABS: Tab[] = [
  { to: '/', end: true, label: '今日', icon: '🏠' },
  { to: '/materials', label: '材料', icon: '📚' },
  { to: '/stats', label: '统计', icon: '📊' },
  { to: '/plan', label: '计划', icon: '🎯' },
];

const DESKTOP_TABS: Tab[] = [
  { to: '/', end: true, label: '今日' },
  { to: '/review', label: '错词本' },
  { to: '/drill', label: '专练' },
  { to: '/materials', label: '材料' },
  { to: '/quiz', label: '小测' },
  { to: '/stats', label: '统计' },
  { to: '/offline', label: '离线' },
  { to: '/plan', label: '计划' },
];

/** 应用外壳：顶部品牌 + 底部主导航。未登录统一引导到登录页。 */
export function App() {
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);
  const loc = useLocation();

  useEffect(() => {
    initReminderScheduler();
  }, []);

  if (loc.pathname === '/login') {
    return (
      <div className="app-shell">
        <header className="app-header"><h1 className="app-title">Ladder</h1><span className="app-subtitle">三步听力法</span></header>
        <main className="app-main"><Outlet /></main>
      </div>
    );
  }

  if (!token) return <Navigate to="/login" replace />;

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-title">Ladder</h1>
        <span className="app-subtitle">三步听力法</span>
        <div className="app-header-actions">
          <NavLink to="/settings" className="btn ghost app-header-btn" title="设置">⚙️</NavLink>
          <button className="btn ghost app-header-btn" onClick={logout} title="退出">⎋</button>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      {/* 移动端：4 tab + 中间浮动训练入口 */}
      <nav className="app-nav app-nav-mobile">
        {MOBILE_TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className="app-nav-item">
            <span className="app-nav-icon">{t.icon}</span>
            <span className="app-nav-label">{t.label}</span>
          </NavLink>
        ))}
        <NavLink to="/listen" className="app-nav-fab" title="开始训练">▶</NavLink>
      </nav>

      {/* 桌面端：8 tab 横向铺开 */}
      <nav className="app-nav app-nav-desktop">
        {DESKTOP_TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end}>{t.label}</NavLink>
        ))}
      </nav>
    </div>
  );
}
