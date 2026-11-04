import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { StageStatus, StageType } from '@ladder/shared';
import { api, uploadFile } from '../../api/client';
import { usePlanStore } from '../../stores/plan';
import { haptic } from '../../lib/haptic';

interface ScenarioDto {
  key: string;
  title: string;
  desc: string;
  scene: string;
}
interface MessageDto {
  id?: string;
  role: 'USER' | 'ASSISTANT';
  text: string;
  audioUrl: string | null;
  createdAt?: string;
}
interface SessionDto {
  sessionId: string;
  scenario: { key: string; title: string; scene: string };
  messages: MessageDto[];
}
interface SummaryDto {
  sessionId: string;
  turns: number;
  userSentences: string[];
  durationHint: string;
}

/**
 * P1 AI 情景对话（阶段三解锁后开放）。
 * 真实语音往返：录音 → /learning/uploads → POST /dialogue/sessions/:id/turn（服务端 ASR→LLM→TTS）→ 播放 AI 语音。
 * 当前 ASR/LLM 为服务端桩实现（见 ai-providers.ts），TTS 为真实 Edge 神经语音。
 */
export function DialoguePage() {
  const { plan, loaded, refresh } = usePlanStore();

  const DEV = import.meta.env.DEV; // dev 环境开启模拟录音辅助
  const [devText, setDevText] = useState(''); // dev 模拟转写

  const [scenarios, setScenarios] = useState<ScenarioDto[]>([]);
  /** 场景列表加载态：空列表时给出明确提示，而不是一片空白 */
  const [scenariosLoading, setScenariosLoading] = useState(true);
  const [session, setSession] = useState<SessionDto | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [recording, setRecording] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [micDenied, setMicDenied] = useState(false);
  const [error, setError] = useState('');

  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** 长按录音中手指滑出按钮区域 → 松手取消（微信语音输入范式） */
  const cancelledRef = useRef(false);

  useEffect(() => { if (!loaded) refresh().catch(() => {}); }, [loaded, refresh]);
  useEffect(() => {
    api<ScenarioDto[]>('/dialogue/scenarios')
      .then(setScenarios)
      .catch((e) => setError(e instanceof Error ? e.message : '对话场景加载失败'))
      .finally(() => setScenariosLoading(false));
  }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const speakStage = plan?.stages.find((s) => s.type === StageType.SPEAK);
  const unlocked = !!speakStage && speakStage.status !== StageStatus.LOCKED;
  const unlockHint = speakStage
    ? `条件：完成听写期天数 + 完成率 ≥80%（当前：${speakStage.status === StageStatus.LOCKED ? '未解锁' : '已解锁'}）`
    : '';

  const startSession = useCallback(async (key: string) => {
    setError('');
    setSummary(null);
    try {
      const s = await api<SessionDto>('/dialogue/sessions', {
        method: 'POST',
        body: JSON.stringify({ scenarioKey: key }),
      });
      setSession(s);
      setMessages(s.messages);
    } catch (e) {
      setError(e instanceof Error ? e.message : '开启对话失败');
    }
  }, []);

  const playAssistant = useCallback((msg: MessageDto) => {
    if (!msg.audioUrl || !audioRef.current) return;
    audioRef.current.src = msg.audioUrl;
    void audioRef.current.play().catch(() => {});
  }, []);

  const sendTurn = useCallback(async (blob: Blob, devTranscript?: string) => {
    if (!session) return;
    setThinking(true);
    setError('');
    try {
      const { url } = await uploadFile('/learning/uploads', blob);
      const r = await api<{ turn: number; user: MessageDto; assistant: MessageDto }>(
        `/dialogue/sessions/${session.sessionId}/turn`,
        { method: 'POST', body: JSON.stringify({ audioUrl: url, ...(devTranscript ? { devTranscript } : {}) }) },
      );
      setMessages((prev) => [...prev, r.user, r.assistant]);
      playAssistant(r.assistant);
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败');
    } finally {
      setThinking(false);
    }
  }, [session, playAssistant]);

  /** dev 辅助：跳过真实录音，直接用文本模拟（后端 devTranscript 桩 ASR 优先采纳） */
  const sendDevText = useCallback(async () => {
    if (!devText.trim()) return;
    // 上传一个占位 webm（内容不重要，后端桩 ASR 不解析音频）
    const fakeBlob = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'audio/webm' });
    await sendTurn(fakeBlob, devText.trim());
    setDevText('');
  }, [devText, sendTurn]);

  // 录音：长按原生体验（微信语音输入范式）
  // pointerdown → 开始录音 + haptic.longPress
  // pointerup → 松手发送（手指还在按钮上）或取消（手指已滑出）
  const startRecording = useCallback(async () => {
    setError('');
    cancelledRef.current = false;
    haptic.longPress();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (cancelledRef.current) {
          haptic.click(); // 取消 → 短点提示
          return;
        }
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        void sendTurn(blob);
      };
      mrRef.current = mr;
      mr.start();
      setRecording(true);
    } catch {
      setMicDenied(true);
    }
  }, [sendTurn]);

  const stopRecording = useCallback(() => {
    haptic.success(); // 松手 → 成功三段震
    mrRef.current?.stop();
    setRecording(false);
  }, []);

  /** 手指滑出按钮 → 标记为取消（松手后不发送） */
  const cancelRecording = useCallback(() => {
    if (!recording) return;
    cancelledRef.current = true;
  }, [recording]);

  const endSession = useCallback(async () => {
    if (!session) return;
    try {
      const s = await api<SummaryDto>(`/dialogue/sessions/${session.sessionId}/end`, { method: 'POST' });
      setSummary(s);
      setSession(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '结束失败');
    }
  }, [session]);

  useEffect(() => () => { mrRef.current?.stop(); }, []);

  if (!loaded) return <p className="muted">加载中…</p>;

  if (!plan) {
    return (
      <div className="card">
        <h2>还没有学习计划</h2>
        <p className="muted">先创建三阶段计划，解锁口语输出阶段后即可练习情景对话。</p>
        <Link to="/onboarding"><button className="btn">创建计划</button></Link>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div className="card">
        <h2>AI 情景对话 <span className="tag locked">未解锁</span></h2>
        <p className="muted">
          情景对话属于阶段三（口语输出）。完成听写阶段后自动解锁，届时可与 AI 在真实场景中一来一往地开口练习。
        </p>
        <p className="muted">{unlockHint}</p>
        <Link to="/plan"><button className="btn ghost">查看计划进度</button></Link>
      </div>
    );
  }

  return (
    <div>
      <audio ref={audioRef} style={{ display: 'none' }} />

      {summary ? (
        <div className="card">
          <h2>本次对话小结</h2>
          <p className="muted">共完成 {summary.turns} 轮对话（{summary.durationHint}）。</p>
          <div style={{ marginTop: 8 }}>
            {summary.userSentences.map((t, i) => (
              <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid #eef1f6' }}>{t}</div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => { setSummary(null); setMessages([]); setSession(null); }}>再练一次</button>
            <Link to="/speaking"><button className="btn ghost">回到口语训练</button></Link>
          </div>
        </div>
      ) : !session ? (
        <>
          <div className="card">
            <h2>AI 情景对话</h2>
            <p className="muted">
              选一个生活场景，和 AI 一来一往地聊。你说完 AI 会用语音回你，就像面对面练习。
              当前版本语音识别与 AI 回复由服务端模拟（TTS 为真实语音），接入模型后即刻升级为真实对话。
            </p>
          </div>
          {error && <p style={{ color: '#b42318' }}>{error}</p>}
          {scenariosLoading && <p className="muted">正在加载对话场景…</p>}
          {!scenariosLoading && !scenarios.length && (
            <div className="card">
              <p className="muted">暂无可用的对话场景，请稍后刷新页面重试。</p>
            </div>
          )}
          {scenarios.map((s) => (
            <div className="card" key={s.key}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <b>{s.title}</b>
                  <div className="muted">{s.desc}</div>
                </div>
                <button className="btn" onClick={() => startSession(s.key)}>开始对话</button>
              </div>
            </div>
          ))}
        </>
      ) : (
        <>
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <b>{session.scenario.title}</b>
                <div className="muted">{session.scenario.scene}</div>
              </div>
              <button className="btn ghost" onClick={endSession}>结束对话</button>
            </div>
          </div>

          {messages.map((m, i) => (
            <div
              key={m.id ?? i}
              className="card"
              style={{
                marginLeft: m.role === 'USER' ? 'auto' : 0,
                maxWidth: '85%',
                background: m.role === 'USER' ? '#1a56db' : undefined,
                color: m.role === 'USER' ? '#fff' : undefined,
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.75 }}>{m.role === 'USER' ? '我' : 'AI'}</div>
              <div style={{ margin: '4px 0' }}>{m.text}</div>
              {m.audioUrl && (
                <button
                  className={m.role === 'USER' ? 'btn ghost' : 'btn'}
                  style={{ padding: '4px 10px', fontSize: 13 }}
                  onClick={() => playAssistant(m)}
                >
                  ▶ 播放
                </button>
              )}
            </div>
          ))}
          <div ref={bottomRef} />

          {thinking && <p className="muted">AI 正在回应…</p>}
          {error && <p style={{ color: '#b42318' }}>{error}</p>}

          <div className="card">
            {micDenied ? (
              <p style={{ color: '#b42318' }}>麦克风不可用：请在浏览器权限中允许「麦克风」后刷新重试。</p>
            ) : (
              <button
                className={`btn${recording ? ' ghost' : ''}`}
                disabled={thinking}
                // React Pointer Events — 同时覆盖 touch / mouse / pen 三种输入
                onPointerDown={startRecording}
                onPointerUp={stopRecording}
                onPointerLeave={cancelRecording}
                onPointerCancel={cancelRecording}
                style={{ width: '100%', minHeight: 56, fontSize: 16, fontWeight: 700 }}
              >
                {recording ? '松开发送 · 滑出取消' : '按住说话'}
              </button>
            )}
          </div>

          {/* dev 辅助：文本模拟录音，绕过麦克风限制 */}
          {DEV && (
            <div className="card" style={{ border: '1px dashed #cfd6e2', background: '#fafbff' }}>
              <p className="muted">🛠 dev 辅助：用文本模拟录音转写（绕过麦克风，后端桩 ASR 优先采纳）</p>
              <div className="row">
                <input
                  type="text"
                  value={devText}
                  onChange={(e) => setDevText(e.target.value)}
                  placeholder="输入一句英文，例如 Hello!"
                  onKeyDown={(e) => { if (e.key === 'Enter') void sendDevText(); }}
                  style={{ flex: 1, minWidth: 200 }}
                />
                <button className="btn ghost" disabled={thinking || !devText.trim()} onClick={() => void sendDevText()}>
                  模拟发送
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
