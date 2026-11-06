import { Suspense, type ReactNode } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { App } from './App';
import { TodayPage } from './pages/Today';
import { lazyPage } from './lib/lazy-page';
import { RouteErrorBoundary } from './components/RouteErrorBoundary';

// P2-10 首屏性能：今日页（index）保持静态导入，避免首屏多一次网络请求；
// 其余 15 个页面按路由懒加载，各自拆成独立 chunk，进入对应页面时才下载。
// P2-14 离线兜底：lazyPage 失败一次会重试，仍失败则由 RouteErrorBoundary 渲染兜底页。
const LoginPage = lazyPage(() => import('./pages/Login').then((m) => ({ default: m.LoginPage })));
const OnboardingPage = lazyPage(() => import('./pages/Onboarding').then((m) => ({ default: m.OnboardingPage })));
const ListenPage = lazyPage(() => import('./pages/Listen').then((m) => ({ default: m.ListenPage })));
const DictationPage = lazyPage(() => import('./pages/Dictation').then((m) => ({ default: m.DictationPage })));
const SpeakingPage = lazyPage(() => import('./pages/Speaking').then((m) => ({ default: m.SpeakingPage })));
const DialoguePage = lazyPage(() => import('./pages/Dialogue').then((m) => ({ default: m.DialoguePage })));
const StatsPage = lazyPage(() => import('./pages/Stats').then((m) => ({ default: m.StatsPage })));
const PlanCompletePage = lazyPage(() => import('./pages/PlanComplete').then((m) => ({ default: m.PlanCompletePage })));
const PlanPage = lazyPage(() => import('./pages/Plan').then((m) => ({ default: m.PlanPage })));
const OfflinePage = lazyPage(() => import('./pages/Offline').then((m) => ({ default: m.OfflinePage })));
const ReviewPage = lazyPage(() => import('./pages/Review').then((m) => ({ default: m.ReviewPage })));
const SettingsPage = lazyPage(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));
const MaterialsPage = lazyPage(() => import('./pages/Materials').then((m) => ({ default: m.MaterialsPage })));
const DrillPage = lazyPage(() => import('./pages/Drill').then((m) => ({ default: m.DrillPage })));
const QuizPage = lazyPage(() => import('./pages/Quiz').then((m) => ({ default: m.QuizPage })));

/** 懒加载页面的统一边界：错误边界在外、Suspense 在内，外壳与导航保持可用 */
function lazyRoute(node: ReactNode) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<p className="muted" style={{ padding: '16px 4px' }}>加载中…</p>}>{node}</Suspense>
    </RouteErrorBoundary>
  );
}

/** 路由与 PRD 功能一一对应：FR-01 引导 → 今日页 → 三阶段训练 → FR-07 统计 → FR-06 完成页 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <TodayPage /> },
      { path: 'login', element: lazyRoute(<LoginPage />) },
      { path: 'onboarding', element: lazyRoute(<OnboardingPage />) },
      { path: 'plan', element: lazyRoute(<PlanPage />) },
      { path: 'listen', element: lazyRoute(<ListenPage />) },
      { path: 'dictation', element: lazyRoute(<DictationPage />) },
      { path: 'speaking', element: lazyRoute(<SpeakingPage />) },
      { path: 'dialogue', element: lazyRoute(<DialoguePage />) },
      { path: 'stats', element: lazyRoute(<StatsPage />) },
      { path: 'plan-complete', element: lazyRoute(<PlanCompletePage />) },
      { path: 'offline', element: lazyRoute(<OfflinePage />) },
      { path: 'review', element: lazyRoute(<ReviewPage />) },
      { path: 'settings', element: lazyRoute(<SettingsPage />) },
      { path: 'materials', element: lazyRoute(<MaterialsPage />) },
      { path: 'drill', element: lazyRoute(<DrillPage />) },
      { path: 'quiz', element: lazyRoute(<QuizPage />) },
    ],
  },
]);
