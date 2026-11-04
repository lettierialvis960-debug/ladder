import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';

/**
 * SR-05 账号入口：学习数据仅登录后生成并归属账号。
 * 注册 / 登录共用一张表单；登录/注册失败返回 401，此处直接读原始响应，
 * 避免走 api client 的「401 即清空登录态」分支。
 */
export function LoginPage() {
  const nav = useNavigate();
  const setToken = useAuthStore((s) => s.setToken);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message ?? '操作失败');
      setToken(body.accessToken as string);
      nav('/', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>{mode === 'login' ? '登录' : '注册'}</h2>
      <p className="muted">三步听力法：先听够量，再写得出，最后说得出。学习数据归属账号（SR-05）。</p>
      <div style={{ margin: '10px 0' }}>
        <input
          type="email"
          placeholder="邮箱"
          value={email}
          autoComplete="username"
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div style={{ margin: '10px 0' }}>
        <input
          type="password"
          placeholder="密码（≥6 位）"
          value={password}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
      </div>
      {error && <p style={{ color: '#b42318' }}>{error}</p>}
      <div className="row">
        <button className="btn" disabled={busy || !email || password.length < 6} onClick={submit}>
          {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>
        <button className="btn ghost" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
          {mode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
        </button>
      </div>
    </div>
  );
}
