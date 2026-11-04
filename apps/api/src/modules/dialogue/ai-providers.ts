import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { StorageService } from '../../common/storage/storage.interface';
import { DIALOGUE_SCENARIOS } from './dialogue.scenarios';

/**
 * AI 能力可插拔层（与 PRD 决策 D3 同思路：供应商选型后置，先定接口）。
 * ASR / LLM / TTS 三层互相独立，当前 ASR 与 LLM 走本地桩，TTS 用 Edge 神经语音（本地可用、无需密钥）。
 * 接入真实供应商时：新增实现类，并在 createAiProviders 中按 AI_PROVIDER 环境变量选择即可。
 */

export interface AsrInput {
  scenarioKey: string;
  turn: number; // 第几轮用户发言（从 1 开始）
  audioBuffer?: Buffer; // P2-1：抽象对象存储后，真实 ASR 读 buffer 而非本地路径
  audioPath?: string;
  devTranscript?: string; // 开发期由客户端模拟识别结果（仅桩模式采纳）
}
export interface LlmInput {
  scenarioKey: string;
  turn: number;
  userText: string;
  history: Array<{ role: string; text: string }>;
}

export interface AsrProvider {
  transcribe(input: AsrInput): Promise<string>;
}
export interface LlmProvider {
  reply(input: LlmInput): Promise<string>;
}
export interface TtsProvider {
  /** 合成成功返回可访问的音频 URL，失败返回 null（客户端降级为浏览器朗读） */
  synthesize(text: string): Promise<string | null>;
}

const findScenario = (key: string) => DIALOGUE_SCENARIOS.find((s) => s.key === key);

/** 桩 ASR：无本地识别引擎，按场景脚本逐轮返回模拟识别结果（或采纳 devTranscript） */
class StubAsr implements AsrProvider {
  async transcribe({ scenarioKey, turn, devTranscript }: AsrInput): Promise<string> {
    if (devTranscript?.trim()) return devTranscript.trim();
    const lines = findScenario(scenarioKey)?.userLines ?? ['Hello!'];
    return lines[(turn - 1) % lines.length];
  }
}

/** 桩 LLM：按场景回复脚本逐轮应答；检测到告别语时收尾 */
class StubLlm implements LlmProvider {
  async reply({ scenarioKey, turn, userText }: LlmInput): Promise<string> {
    const replies = findScenario(scenarioKey)?.replies ?? ['I see. Please go on.'];
    if (/bye|goodbye|see you|thank you/i.test(userText)) return replies[replies.length - 1];
    return replies[Math.min(turn - 1, replies.length - 1)];
  }
}

/**
 * 真实 LLM：OpenAI 兼容协议（/chat/completions）。
 * 配置：LLM_BASE_URL（默认 OpenAI 官方）、LLM_API_KEY、LLM_MODEL。
 * 失败时回退到桩回复，避免因网络/配额问题中断对话。
 */
class OpenAiCompatLlm implements LlmProvider {
  private readonly base: string;
  private readonly key: string;
  private readonly model: string;
  private readonly log = new Logger(OpenAiCompatLlm.name);

  constructor() {
    this.base = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.key = process.env.LLM_API_KEY || '';
    this.model = process.env.LLM_MODEL || 'gpt-4o-mini';
  }

  async reply({ scenarioKey, userText, history }: LlmInput): Promise<string> {
    const sc = findScenario(scenarioKey);
    const system = [
      'You are role-playing an English dialogue with a learner.',
      `Setting: ${sc?.scene || 'A daily conversation.'}`,
      'Stay in character. Keep each reply short (1-2 sentences) and natural.',
      'Reply only in English.',
    ].join('\n');

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: system },
      ...history.map((m) => ({
        role: (m.role === 'USER' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.text,
      })),
      { role: 'user', content: userText },
    ];

    try {
      const res = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: this.model, messages, temperature: 0.7, max_tokens: 120 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('empty reply');
      return text;
    } catch (e) {
      this.log.warn(`LLM 调用失败，回退桩回复：${(e as Error).message}`);
      const replies = sc?.replies ?? ['I see. Please go on.'];
      return replies[Math.floor(Math.random() * replies.length)];
    }
  }
}

/** TTS：Edge 神经语音（en-US-JennyNeural），产物通过 StorageService 统一存储 */
class EdgeTts implements TtsProvider {
  private readonly log = new Logger(EdgeTts.name);
  private readonly storage: StorageService;

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  async synthesize(text: string): Promise<string | null> {
    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata('en-US-JennyNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = await tts.toStream(text, { rate: '-10%' });
      const chunks: Buffer[] = [];
      for await (const c of audioStream) chunks.push(Buffer.from(c));
      const buffer = Buffer.concat(chunks);
      const key = `dialogue/dg-${randomUUID()}.mp3`;
      await this.storage.putBuffer(key, buffer, 'audio/mpeg');
      return this.storage.getPublicUrl(key);
    } catch (e) {
      this.log.warn(`TTS 合成失败，本条回复无语音：${(e as Error).message}`);
      return null;
    }
  }
}

export interface AiProviders {
  mode: string;
  asr: AsrProvider;
  llm: LlmProvider;
  tts: TtsProvider;
}

/** 供应商装配：AI_PROVIDER=stub（默认）用桩实现；openai 需配置 LLM_API_KEY 后启用真实 LLM */
export function createAiProviders(storage: StorageService): AiProviders {
  const mode = (process.env.AI_PROVIDER ?? 'stub').toLowerCase();
  const useOpenAi = mode === 'openai' && !!process.env.LLM_API_KEY;
  if (mode === 'openai' && !process.env.LLM_API_KEY) {
    new Logger('AiProviders').warn('AI_PROVIDER=openai 但未设置 LLM_API_KEY，回退到 stub');
  }
  const llm = useOpenAi ? new OpenAiCompatLlm() : new StubLlm();
  return { mode: useOpenAi ? 'openai' : 'stub', asr: new StubAsr(), llm, tts: new EdgeTts(storage) };
}
