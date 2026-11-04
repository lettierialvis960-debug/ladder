import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { StageStatus, StageType } from '@ladder/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.interface';
import { createAiProviders, type AiProviders } from './ai-providers';
import { DIALOGUE_SCENARIOS } from './dialogue.scenarios';

/**
 * P1 AI 情景对话（阶段三解锁后开放）。
 * 真实语音往返：客户端录音上传 → ASR 转写 → LLM 生成回复 → TTS 合成语音返回。
 * 当前 ASR/LLM 为桩实现、TTS 为 Edge 神经语音，见 ai-providers.ts（可插拔，换供应商只改装配处）。
 * P2-1：TTS 产物通过 StorageService 统一存储（本地 / S3 兼容）。
 */
@Injectable()
export class DialogueService {
  private readonly ai: AiProviders;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {
    this.ai = createAiProviders(this.storage);
  }

  /** 场景目录（不含桩语料，避免泄漏"标准答案"） */
  listScenarios() {
    return DIALOGUE_SCENARIOS.map(({ key, title, desc, scene }) => ({ key, title, desc, scene }));
  }

  private async assertUnlocked(userId: string) {
    const plan = await this.prisma.plan.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { stages: true },
    });
    if (!plan) throw new ForbiddenException('还没有进行中的学习计划');
    const speak = plan.stages.find((s) => s.type === StageType.SPEAK);
    if (!speak || speak.status === StageStatus.LOCKED) {
      throw new ForbiddenException('情景对话在阶段三（口语输出）解锁后开放');
    }
    return plan;
  }

  /** 开新会话：落库用户档案 → 生成并保存 AI 开场白（含语音） */
  async createSession(userId: string, scenarioKey: string) {
    await this.assertUnlocked(userId);
    const sc = DIALOGUE_SCENARIOS.find((s) => s.key === scenarioKey);
    if (!sc) throw new BadRequestException('场景不存在');

    const session = await this.prisma.dialogueSession.create({
      data: { userId, scenarioKey },
    });
    const audioUrl = await this.ai.tts.synthesize(sc.opening);
    const opening = await this.prisma.dialogueMessage.create({
      data: { sessionId: session.id, role: 'ASSISTANT', text: sc.opening, audioUrl },
    });
    return { sessionId: session.id, scenario: { key: sc.key, title: sc.title, scene: sc.scene }, messages: [opening] };
  }

  async getSession(userId: string, sessionId: string) {
    const session = await this.prisma.dialogueSession.findFirst({
      where: { id: sessionId, userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw new NotFoundException('会话不存在');
    const sc = DIALOGUE_SCENARIOS.find((s) => s.key === session.scenarioKey);
    return {
      ...session,
      scenario: sc ? { key: sc.key, title: sc.title, scene: sc.scene } : null,
    };
  }

  /**
   * 一轮对话：客户端先 POST /learning/uploads 拿录音 URL，再带上它调用本接口。
   * turn = 已完成用户发言数 + 1，用于桩脚本推进。
   * P2-1：audioBuffer 从 StorageService 获取（真实 ASR 需要时启用）；当前桩 ASR 只采纳 devTranscript。
   */
  async sendTurn(userId: string, sessionId: string, body: { audioUrl: string; devTranscript?: string }) {
    const session = await this.prisma.dialogueSession.findFirst({ where: { id: sessionId, userId } });
    if (!session) throw new NotFoundException('会话不存在');
    if (session.status !== 'ACTIVE') throw new BadRequestException('会话已结束，请重新开始');

    const turn = session.turns + 1;
    // P2-1：从 StorageService 读录音 buffer（未来真实 ASR 用）
    let audioBuffer: Buffer | undefined;
    const key = this.storage.parseKeyFromUrl(body.audioUrl);
    if (key) {
      try { audioBuffer = await this.storage.getBuffer(key); } catch { /* 文件不存在跳过 */ }
    }

    const userText = await this.ai.asr.transcribe({
      scenarioKey: session.scenarioKey,
      turn,
      audioBuffer,
      devTranscript: body.devTranscript,
    });
    if (!userText.trim()) throw new BadRequestException('没有识别到语音，请重试');

    const history = await this.prisma.dialogueMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: { role: true, text: true },
    });
    const replyText = await this.ai.llm.reply({ scenarioKey: session.scenarioKey, turn, userText, history });
    const replyAudio = await this.ai.tts.synthesize(replyText);

    const [, assistant] = await this.prisma.$transaction([
      this.prisma.dialogueMessage.create({ data: { sessionId, role: 'USER', text: userText, audioUrl: body.audioUrl } }),
      this.prisma.dialogueMessage.create({ data: { sessionId, role: 'ASSISTANT', text: replyText, audioUrl: replyAudio } }),
      this.prisma.dialogueSession.update({ where: { id: sessionId }, data: { turns: turn } }),
    ]);

    return {
      turn,
      user: { role: 'USER', text: userText, audioUrl: body.audioUrl },
      assistant,
    };
  }

  /** 结束会话并给出小结（轮数 + 用户发言全文，供复盘） */
  async endSession(userId: string, sessionId: string) {
    const session = await this.prisma.dialogueSession.findFirst({
      where: { id: sessionId, userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw new NotFoundException('会话不存在');
    await this.prisma.dialogueSession.update({ where: { id: sessionId }, data: { status: 'ENDED' } });
    const userMessages = session.messages.filter((m) => m.role === 'USER');
    return {
      sessionId,
      turns: session.turns,
      userSentences: userMessages.map((m) => m.text),
      durationHint: `${session.turns} 轮对话`,
    };
  }
}
