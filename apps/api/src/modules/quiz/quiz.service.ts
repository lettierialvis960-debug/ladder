import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { QuizQuestionDto, QuizSubmitResultDto } from '@ladder/shared';

interface StoredQuestion {
  id: string;
  type: 'LISTEN_CHOICE' | 'WORD_PHONETIC';
  prompt: string;
  audioUrl?: string;
  options: string[];
  answer: string; // 正确选项文本
}

const PASS_THRESHOLD = 0.6;
const DEFAULT_COUNT = 10;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

@Injectable()
export class QuizService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * P1-3 生成分级小测：从该级别官方内容包的句子中随机抽题。
   * 题型 LISTEN_CHOICE：播放句子音频，4 选 1 正确译文。
   */
  async generate(userId: string, levelCode: string, count = DEFAULT_COUNT) {
    const n = Math.min(Math.max(1, count), 30);
    const sentences = await this.prisma.sentence.findMany({
      where: { item: { pack: { levelCode, ownerId: null } } },
      select: { id: true, text: true, translation: true, audioUrl: true, itemId: true },
    });
    if (sentences.length < 4) {
      throw new BadRequestException(`级别 ${levelCode} 内容不足，无法生成小测`);
    }

    // 干扰项池：该级别所有句子的译文（去重）
    const allTranslations = Array.from(new Set(sentences.map((s) => s.translation).filter(Boolean)));

    const picked = shuffle(sentences).slice(0, n);
    const stored: StoredQuestion[] = picked.map((s, idx) => {
      const correct = s.translation;
      const distractors = shuffle(allTranslations.filter((t) => t !== correct)).slice(0, 3);
      const options = shuffle([correct, ...distractors]);
      return {
        id: `q${idx + 1}`,
        type: 'LISTEN_CHOICE' as const,
        prompt: '听句子，选出正确的译文',
        audioUrl: s.audioUrl,
        options,
        answer: correct,
      };
    });

    const session = await this.prisma.quizSession.create({
      data: {
        userId,
        levelCode,
        questionsJson: JSON.stringify(stored),
        total: stored.length,
      },
    });

    return this.toDto(session, stored);
  }

  async getSession(userId: string, sessionId: string) {
    const session = await this.prisma.quizSession.findFirst({ where: { id: sessionId, userId } });
    if (!session) throw new NotFoundException('小测不存在');
    const stored: StoredQuestion[] = JSON.parse(session.questionsJson);
    return this.toDto(session, stored);
  }

  async submit(userId: string, sessionId: string, answers: Array<{ questionId: string; answer: string }>): Promise<QuizSubmitResultDto> {
    const session = await this.prisma.quizSession.findFirst({ where: { id: sessionId, userId } });
    if (!session) throw new NotFoundException('小测不存在');
    if (session.score != null) throw new BadRequestException('该小测已提交，不能重复作答');

    const stored: StoredQuestion[] = JSON.parse(session.questionsJson);
    const answerMap = new Map(answers.map((a) => [a.questionId, a.answer]));

    const details = stored.map((q) => {
      const userAnswer = answerMap.get(q.id) ?? '';
      const correct = userAnswer === q.answer;
      return { questionId: q.id, correct, answer: userAnswer, correctAnswer: q.answer };
    });
    const score = details.filter((d) => d.correct).length;
    const passed = score / session.total >= PASS_THRESHOLD;

    await this.prisma.quizSession.update({
      where: { id: sessionId },
      data: { score, passed },
    });

    const suggestion = passed
      ? `答对 ${score}/${session.total}，达到 ${levelName(session.levelCode)} 级别要求，继续保持！`
      : `答对 ${score}/${session.total}，建议先完成本阶段的每日任务，再挑战小测。`;

    return { sessionId, score, total: session.total, passed, details, suggestion };
  }

  async history(userId: string) {
    return this.prisma.quizSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, levelCode: true, total: true, score: true, passed: true, createdAt: true },
    });
  }

  private toDto(session: { id: string; levelCode: string; total: number; score: number | null; passed: boolean | null; createdAt: Date }, stored: StoredQuestion[]) {
    const questions: QuizQuestionDto[] = stored.map(({ answer, ...q }) => q);
    return {
      id: session.id,
      levelCode: session.levelCode,
      total: session.total,
      questions,
      score: session.score ?? undefined,
      passed: session.passed ?? undefined,
      createdAt: session.createdAt.toISOString(),
    };
  }
}

function levelName(code: string): string {
  return { L1: '初阶', L2: '中阶', L3: '高阶' }[code] ?? code;
}
