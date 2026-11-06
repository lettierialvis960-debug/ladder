import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  DAILY_LISTEN_CAP_MIN,
  DAILY_RETELL_PASSAGES,
  StageType,
} from '@ladder/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { SpeechScoringService } from './speech-scoring.service';

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface DrillSentence {
  id: string;
  text: string;
  translation: string;
  audioUrl: string;
  item: { title: string };
}

/** A2 SRS：连续「记住了」的复习间隔（天），连续 SRS_MASTER_REVIEWS 次即毕业 */
const SRS_INTERVALS = [1, 3, 7];
const SRS_MASTER_REVIEWS = 4;

const WRONG_WORD_SELECT = {
  id: true, word: true, dueAt: true, reviewCount: true, createdAt: true,
  sentence: {
    select: {
      id: true, text: true, translation: true, audioUrl: true,
      item: { select: { id: true, title: true } },
    },
  },
} as const;

@Injectable()
export class LearningService {
  private readonly log = new Logger(LearningService.name);
  constructor(private readonly prisma: PrismaService, private readonly scoring: SpeechScoringService) {}
  /**
   * SR-01 有效听时长：按 用户+材料+日期 累加，单日全材料合计封顶 DAILY_LISTEN_CAP_MIN。
   * 达标 DAILY_LISTEN_GOAL_MIN 即自动打卡（SR-02：系统触发，无手动入口）。
   */
  async reportListening(userId: string, dto: { itemId: string; date: string; effectiveSec: number }) {
    const goals = await this.userGoals(userId);
    const dayTotal = await this.dailyListenSec(userId, dto.date);
    const room = Math.max(0, DAILY_LISTEN_CAP_MIN * 60 - dayTotal);
    if (room === 0) return { acceptedSec: 0, capped: true };

    const accepted = Math.min(dto.effectiveSec, room);
    const session = await this.prisma.listeningSession.upsert({
      where: { userId_itemId_date: { userId, itemId: dto.itemId, date: dto.date } },
      update: { effectiveSec: { increment: accepted } },
      create: { userId, itemId: dto.itemId, date: dto.date, effectiveSec: accepted },
    });

    const newTotal = dayTotal + accepted;
    if (newTotal >= goals.listenMin * 60) {
      await this.checkin(userId, dto.date, StageType.LISTEN);
    }
    return { acceptedSec: accepted, capped: accepted < dto.effectiveSec, dayTotalSec: newTotal, sessionId: session.id };
  }

  /** FR-04：听写留档 + 错词入库（复习功能 P1，见 PRD 4.3） */
  async saveDictation(userId: string, dto: { sentenceId: string; date: string; input: string; correctRate: number; replayCount: number; wrongWords: string[] }) {
    const attempt = await this.prisma.dictationAttempt.create({
      data: { userId, ...dto, wrongWords: JSON.stringify(dto.wrongWords) },
    });
    if (dto.wrongWords.length) {
      await this.prisma.wrongWord.createMany({
        data: dto.wrongWords.map((word) => ({ userId, word, sentenceId: dto.sentenceId })),
      });
    }
    // 打卡：当日完成篇数达标（篇数 = 当日有记录的句所属材料去重数）
    const [donePassages, goals] = await Promise.all([
      this.dailyDictationPassages(userId, dto.date),
      this.userGoals(userId),
    ]);
    if (donePassages >= goals.dictationPassages) {
      await this.checkin(userId, dto.date, StageType.DICTATE);
    }
    // FR-06：刷新听写阶段完成率（plans.service 按 completionRate 决定能否自动推进）
    await this.refreshCompletionRate(userId, StageType.DICTATE);
    return attempt;
  }

  /** FR-05：口语记录；跟读句数 + 复述段数达标后自动打卡。评分由 SpeechScoringService 同步计算并回写 score/wordsFeedback。 */
  async saveSpeaking(userId: string, dto: {
    type: 'READ' | 'RETELL'; date: string;
    sentenceId?: string; itemId?: string;
    audioUrl: string; durationSec: number;
    score?: number; transcript?: string;
  }) {
    if (dto.type === 'READ' && !dto.sentenceId) throw new BadRequestException('跟读记录缺少 sentenceId');
    if (dto.type === 'RETELL' && !dto.itemId) throw new BadRequestException('复述记录缺少 itemId');

    // Prisma SpeakingRecord 无 transcript 字段，显式挑出
    const createData = {
      userId, type: dto.type, date: dto.date,
      sentenceId: dto.sentenceId ?? null,
      itemId: dto.itemId ?? null,
      audioUrl: dto.audioUrl, durationSec: dto.durationSec,
      score: dto.score ?? null,
    };
    const record = await this.prisma.speakingRecord.create({ data: createData });

    // 评分：READ 用 WER（有 transcript）或时长比例；RETELL 用时长比例
    try {
      let scoringResult: { score: number; wordsFeedback: Array<{ word: string; ok: boolean }> };
      if (dto.type === 'READ') {
        const sentence = await this.prisma.sentence.findUnique({
          where: { id: dto.sentenceId },
          select: { text: true, itemId: true, item: { select: { durationSec: true } } },
        });
        if (!sentence) throw new BadRequestException('句子不存在');
        const itemId = sentence.itemId;
        const totalInItem = itemId ? await this.prisma.sentence.count({ where: { itemId } }) : 1;
        const refDur = sentence.item?.durationSec
          ? Math.max(1, Math.round(sentence.item.durationSec / Math.max(1, totalInItem)))
          : dto.durationSec;
        scoringResult = await this.scoring.scoreReadAloud({
          audioDuration: dto.durationSec,
          referenceText: sentence.text,
          referenceDurationSec: refDur,
          transcript: dto.transcript,
        });
      } else {
        const item = await this.prisma.contentItem.findUnique({
          where: { id: dto.itemId },
          select: { durationSec: true },
        });
        scoringResult = await this.scoring.scoreRetell({
          audioDuration: dto.durationSec,
          referenceDurationSec: item?.durationSec ?? dto.durationSec,
        });
      }
      const updated = await this.prisma.speakingRecord.update({
        where: { id: record.id },
        data: {
          score: scoringResult.score,
          wordsFeedback: scoringResult.wordsFeedback.length > 0 ? JSON.stringify(scoringResult.wordsFeedback) : null,
        },
      });
      // 打卡 + 完成率刷新
      const [reads, retells, goals] = await Promise.all([
        this.prisma.speakingRecord.count({ where: { userId, date: dto.date, type: 'READ' } }),
        this.prisma.speakingRecord.count({ where: { userId, date: dto.date, type: 'RETELL' } }),
        this.userGoals(userId),
      ]);
      if (reads >= goals.readSentences && retells >= DAILY_RETELL_PASSAGES) {
        await this.checkin(userId, dto.date, StageType.SPEAK);
      }
      await this.refreshCompletionRate(userId, StageType.SPEAK);
      return updated;
    } catch (e) {
      this.log.warn(`口语评分失败（已保存录音但未打分）：${(e as Error).message}`);
      // 评分失败不阻塞保存——只做打卡 + 完成率
      const [reads, retells, goals] = await Promise.all([
        this.prisma.speakingRecord.count({ where: { userId, date: dto.date, type: 'READ' } }),
        this.prisma.speakingRecord.count({ where: { userId, date: dto.date, type: 'RETELL' } }),
        this.userGoals(userId),
      ]);
      if (reads >= goals.readSentences && retells >= DAILY_RETELL_PASSAGES) {
        await this.checkin(userId, dto.date, StageType.SPEAK);
      }
      await this.refreshCompletionRate(userId, StageType.SPEAK);
      return record;
    }
  }

  /** F2 收藏夹：收藏的句子（按收藏时间倒序，附原句与材料标题） */
  favoriteSentences(userId: string) {
    return this.prisma.favoriteSentence.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, createdAt: true,
        sentence: {
          select: {
            id: true, text: true, translation: true, audioUrl: true,
            item: { select: { id: true, title: true } },
          },
        },
      },
    });
  }

  /** F2 收藏（幂等：重复收藏不报错） */
  async addFavorite(userId: string, sentenceId: string) {
    const sentence = await this.prisma.sentence.findUnique({ where: { id: sentenceId }, select: { id: true } });
    if (!sentence) throw new BadRequestException('句子不存在');
    return this.prisma.favoriteSentence.upsert({
      where: { userId_sentenceId: { userId, sentenceId } },
      update: {},
      create: { userId, sentenceId },
    });
  }

  /** F2 取消收藏（按句子 id，幂等） */
  async removeFavorite(userId: string, sentenceId: string) {
    await this.prisma.favoriteSentence.deleteMany({ where: { userId, sentenceId } });
    return { ok: true };
  }

  /** D1 跟读对照回放：保存自评星级（1~5），仅限本人录音。 */
  async rateSpeaking(userId: string, id: string, rating: number) {
    const record = await this.prisma.speakingRecord.findFirst({ where: { id, userId } });
    if (!record) throw new BadRequestException('录音记录不存在');
    return this.prisma.speakingRecord.update({ where: { id }, data: { selfRating: rating } });
  }

  /** P1 错词本：待复习列表（未掌握），按最近出错时间倒序，附原句供回听/回写。 */
  wrongWords(userId: string) {
    return this.prisma.wrongWord.findMany({
      where: { userId, mastered: false },
      orderBy: { createdAt: 'desc' },
      select: WRONG_WORD_SELECT,
    });
  }

  /**
   * A2 错词本 SRS：到期队列与统计。
   * due = dueAt 已过（到期待复习）；其中 dueAt 早于今天零点记为逾期。
   */
  async dueWrongWords(userId: string) {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const [learning, mastered] = await Promise.all([
      this.prisma.wrongWord.findMany({
        where: { userId, mastered: false },
        orderBy: { dueAt: 'asc' },
        select: WRONG_WORD_SELECT,
      }),
      this.prisma.wrongWord.count({ where: { userId, mastered: true } }),
    ]);

    const due = learning.filter((w) => w.dueAt <= now);
    const upcoming = learning.filter((w) => w.dueAt > now);
    return {
      due,
      upcoming,
      stats: {
        due: due.length,
        overdue: due.filter((w) => w.dueAt < startOfToday).length,
        learning: upcoming.length,
        mastered,
      },
    };
  }

  /**
   * A2 SRS 复习反馈：记住了 → 按 1/3/7 天递进，连续 4 次毕业（掌握）；
   * 再练一次 → 归零，立即回到待复习队列。
   */
  async reviewWrongWord(userId: string, id: string, remembered: boolean) {
    const word = await this.prisma.wrongWord.findFirst({ where: { id, userId } });
    if (!word) throw new BadRequestException('词条不存在');

    if (!remembered) {
      const updated = await this.prisma.wrongWord.update({
        where: { id },
        data: { reviewCount: 0, dueAt: new Date() },
      });
      await this.prisma.reviewLog.create({ data: { userId, wrongWordId: id, word: word.word, remembered: false } });
      return updated;
    }

    const next = word.reviewCount + 1;
    const mastered = next >= SRS_MASTER_REVIEWS;
    const dueAt = mastered
      ? new Date()
      : new Date(Date.now() + SRS_INTERVALS[next - 1] * 86400000);
    const updated = await this.prisma.wrongWord.update({
      where: { id },
      data: { reviewCount: next, mastered, dueAt },
    });
    await this.prisma.reviewLog.create({ data: { userId, wrongWordId: id, word: word.word, remembered: true } });
    return updated;
  }

  /** I1 近 N 天复习趋势（默认 7 天）：按本地日期聚合次数与记住率 */
  async reviewStats(userId: string, days = 7) {
    const n = Math.min(30, Math.max(1, Math.floor(days) || 7));
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (n - 1));

    const logs = await this.prisma.reviewLog.findMany({
      where: { userId, createdAt: { gte: start } },
      select: { remembered: true, createdAt: true },
    });

    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const buckets = new Map<string, { total: number; remembered: number }>();
    for (let i = 0; i < n; i += 1) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      buckets.set(key(d), { total: 0, remembered: 0 });
    }
    logs.forEach((l) => {
      const b = buckets.get(key(l.createdAt));
      if (!b) return;
      b.total += 1;
      if (l.remembered) b.remembered += 1;
    });

    const list = [...buckets.entries()].map(([date, v]) => ({
      date,
      total: v.total,
      remembered: v.remembered,
      rate: v.total ? v.remembered / v.total : 0,
    }));
    const total = list.reduce((s, d) => s + d.total, 0);
    const remembered = list.reduce((s, d) => s + d.remembered, 0);
    return {
      startDate: list[0]?.date ?? key(start),
      endDate: list[list.length - 1]?.date ?? key(new Date()),
      days: list,
      total,
      remembered,
      rate: total ? remembered / total : 0,
    };
  }

  /** P1 错词本：标记已掌握（仅允许操作本人词条）。 */
  async masterWrongWord(userId: string, id: string) {
    const word = await this.prisma.wrongWord.findFirst({ where: { id, userId } });
    if (!word) throw new BadRequestException('词条不存在');
    return this.prisma.wrongWord.update({ where: { id }, data: { mastered: true } });
  }

  /**
   * F2 错词批量操作：批量标记已掌握 / 批量删除（仅限本人词条）。
   * 返回受影响条数，便于前端提示。
   */
  async batchWrongWords(userId: string, ids: string[], action: 'mastered' | 'delete') {
    if (!ids.length) throw new BadRequestException('未选择词条');
    if (action === 'mastered') {
      const r = await this.prisma.wrongWord.updateMany({
        where: { userId, id: { in: ids } },
        data: { mastered: true },
      });
      return { updated: r.count, deleted: 0 };
    }
    const r = await this.prisma.wrongWord.deleteMany({ where: { userId, id: { in: ids } } });
    return { updated: 0, deleted: r.count };
  }

  /** P1「没听懂」标记：听力中标记未听懂的句子（幂等；重复标记时重置为待复习）。 */
  async markConfused(userId: string, sentenceId: string) {
    const sentence = await this.prisma.sentence.findUnique({ where: { id: sentenceId } });
    if (!sentence) throw new BadRequestException('句子不存在');
    return this.prisma.confusedMark.upsert({
      where: { userId_sentenceId: { userId, sentenceId } },
      update: { resolved: false },
      create: { userId, sentenceId },
    });
  }

  /** P1「没听懂」标记：取消标记（误触撤回，仅限本人）。 */
  async unmarkConfused(userId: string, sentenceId: string) {
    await this.prisma.confusedMark.deleteMany({ where: { userId, sentenceId } });
    return { ok: true };
  }

  /** P1 复习队列：没听懂的句子（未标记已听懂），按标记时间倒序，附原句与所属材料。 */
  confusedList(userId: string) {
    return this.prisma.confusedMark.findMany({
      where: { userId, resolved: false },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        sentence: {
          select: {
            id: true, text: true, translation: true, audioUrl: true,
            item: { select: { id: true, title: true } },
          },
        },
      },
    });
  }

  /** P1 复习队列：标记已听懂（仅允许操作本人标记）。 */
  async resolveConfused(userId: string, id: string) {
    const mark = await this.prisma.confusedMark.findFirst({ where: { id, userId } });
    if (!mark) throw new BadRequestException('标记不存在');
    return this.prisma.confusedMark.update({ where: { id }, data: { resolved: true } });
  }

  /** K2「没听懂」批量标记已听懂：仅处理本人未解决标记，返回实际处理条数。 */
  async batchResolveConfused(userId: string, ids: string[]) {
    if (!ids.length) throw new BadRequestException('未选择标记');
    const r = await this.prisma.confusedMark.updateMany({
      where: { userId, id: { in: ids }, resolved: false },
      data: { resolved: true },
    });
    return { resolved: r.count };
  }

  /**
   * P2-2「没听懂 → 阶段二优先听写」联动（PRD 4.3）：
   * 返回该用户在指定包内未解决的没听懂句子（限听写清单内材料），
   * 已 resolved 或当日已听写过的句子不再优先。
   */
  async dictationPriority(userId: string, packId: string, date: string) {
    const marks = await this.prisma.confusedMark.findMany({
      where: {
        userId,
        resolved: false,
        // B1：优先队列同时覆盖当前计划包与本人自定义材料
        sentence: { item: { inDictationList: true, OR: [{ packId }, { pack: { ownerId: userId } }] } },
      },
      orderBy: { createdAt: 'desc' },
      select: { sentenceId: true, sentence: { select: { itemId: true } } },
    });
    if (!marks.length) return { sentenceIds: [], itemIds: [] };

    const doneToday = await this.prisma.dictationAttempt.findMany({
      where: { userId, date, sentenceId: { in: marks.map((m) => m.sentenceId) } },
      distinct: ['sentenceId'],
      select: { sentenceId: true },
    });
    const doneSet = new Set(doneToday.map((d) => d.sentenceId));
    const pending = marks.filter((m) => !doneSet.has(m.sentenceId));

    return {
      sentenceIds: pending.map((m) => m.sentenceId),
      itemIds: [...new Set(pending.map((m) => m.sentence.itemId))],
    };
  }

  /**
   * 当日听写完成情况：按句取历史最佳正确率。
   * 保留每次 attempt（复盘价值），前端据此展示「已完成 / 最佳成绩」，刷新后不丢。
   */
  async dictationToday(userId: string, date: string, itemId?: string) {
    const rows = await this.prisma.dictationAttempt.findMany({
      where: { userId, date, ...(itemId ? { sentence: { itemId } } : {}) },
      select: { sentenceId: true, correctRate: true },
      orderBy: { createdAt: 'asc' },
    });
    const best = new Map<string, number>();
    for (const row of rows) {
      best.set(row.sentenceId, Math.max(best.get(row.sentenceId) ?? 0, row.correctRate));
    }
    return Array.from(best, ([sentenceId, correctRate]) => ({ sentenceId, correctRate }));
  }

  /**
   * A1 弱项专项训练：聚合三类弱项信号，按权重排序返回今日待练句。
   * 没听懂 +5；错词 +2 且每多一个错词 +0.5（上限 +1.5）；听写低正确率 +3 且越低越高。
   * 当日已听写过的句子排除，避免重复劳动。
   */
  async weakDrill(userId: string, limit = 10) {
    const date = localDate();
    const since = shiftDate(date, -14);
    const take = Math.min(20, Math.max(5, limit));
    const select = { id: true, text: true, translation: true, audioUrl: true, item: { select: { title: true } } } as const;

    const [confused, words, lowAcc, doneToday] = await Promise.all([
      this.prisma.confusedMark.findMany({
        where: { userId, resolved: false },
        select: { sentence: { select } },
        take: 200,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.wrongWord.findMany({
        where: { userId, mastered: false },
        select: { word: true, sentence: { select } },
        take: 300,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.dictationAttempt.findMany({
        where: { userId, date: { gte: since }, correctRate: { lt: 0.8 } },
        select: { sentenceId: true, correctRate: true, sentence: { select } },
        take: 300,
        orderBy: { date: 'desc' },
      }),
      this.prisma.dictationAttempt.findMany({
        where: { userId, date },
        select: { sentenceId: true },
        distinct: ['sentenceId'],
      }),
    ]);

    const acc = new Map<string, { sentence: DrillSentence; score: number; reasons: Set<string>; words: Set<string> }>();
    const add = (sentence: DrillSentence | null, delta: number, reason: string, word?: string) => {
      if (!sentence) return;
      const cur = acc.get(sentence.id) ?? { sentence, score: 0, reasons: new Set<string>(), words: new Set<string>() };
      cur.score += delta;
      cur.reasons.add(reason);
      if (word) cur.words.add(word);
      acc.set(sentence.id, cur);
    };

    confused.forEach((m) => add(m.sentence as DrillSentence | null, 5, '没听懂'));
    words.forEach((w) => add(w.sentence as DrillSentence | null, 2, '错词', w.word));
    lowAcc.forEach((a) => add(a.sentence as DrillSentence | null, 3 + (0.8 - a.correctRate) * 10, '听写正确率低'));

    const done = new Set(doneToday.map((d) => d.sentenceId));
    return [...acc.values()]
      .filter((v) => !done.has(v.sentence.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, take)
      .map((v) => ({
        id: v.sentence.id,
        text: v.sentence.text,
        translation: v.sentence.translation,
        audioUrl: v.sentence.audioUrl,
        itemTitle: v.sentence.item.title,
        reasons: [...v.reasons],
        score: Math.round(v.score * 10) / 10,
        words: [...v.words],
      }));
  }

  private async dailyListenSec(userId: string, date: string): Promise<number> {
    const agg = await this.prisma.listeningSession.aggregate({ where: { userId, date }, _sum: { effectiveSec: true } });
    return agg._sum.effectiveSec ?? 0;
  }

  private async dailyDictationPassages(userId: string, date: string): Promise<number> {
    const attempts = await this.prisma.dictationAttempt.findMany({
      where: { userId, date },
      select: { sentence: { select: { itemId: true } } },
    });
    return new Set(attempts.map((a) => a.sentence.itemId)).size;
  }

  /** G2 每日目标：读取用户自定义值，缺省回退 shared 常量 */
  private async userGoals(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { dailyListenMin: true, dailyDictationPassages: true, dailyReadSentences: true },
    });
    return {
      listenMin: u?.dailyListenMin ?? 60,
      dictationPassages: u?.dailyDictationPassages ?? 1,
      readSentences: u?.dailyReadSentences ?? 10,
    };
  }

  /** SR-02 打卡（幂等：同用户同日同阶段唯一） */
  private async checkin(userId: string, date: string, stageType: StageType) {
    await this.prisma.dailyCheckin.upsert({
      where: { userId_date_stageType: { userId, date, stageType } },
      update: { done: true },
      create: { userId, date, stageType, done: true },
    });
  }

  /**
   * FR-06：每次保存 dictation / speaking 后刷新当前 ACTIVE 阶段的 completionRate。
   * plans.service 按该值判断阶段是否完成（阈值 STAGE_COMPLETION_THRESHOLD=0.8）。
   * 口径：dictation 按 sentence 粒度（整包 sentence 覆盖比例）；
   * speaking 按 item 粒度（复述完所有 item 即 100%，覆盖 READ + RETELL 两种模式）。
   * 仅对 ACTIVE 阶段刷新；LISTEN 阶段不使用 completionRate。
   */
  private async refreshCompletionRate(userId: string, stageType: StageType) {
    if (stageType !== StageType.DICTATE && stageType !== StageType.SPEAK) return;
    const plan = await this.prisma.plan.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { stages: true },
    });
    const stage = plan?.stages.find((s) => s.type === stageType && s.status === 'ACTIVE');
    if (!plan || !stage) return;

    let total = 0;
    let done = 0;
    if (stageType === StageType.DICTATE) {
      const items = await this.prisma.contentItem.findMany({ where: { packId: plan.packId, inDictationList: true }, select: { id: true } });
      total = await this.prisma.sentence.count({ where: { itemId: { in: items.map((i) => i.id) } } });
      const rows = await this.prisma.dictationAttempt.findMany({
        where: { userId, sentence: { item: { packId: plan.packId } } },
        select: { sentenceId: true },
        distinct: ['sentenceId'],
      });
      done = rows.length;
    } else {
      // speaking：item 粒度（RETELL 记录 + READ 所属 item 覆盖）
      const items = await this.prisma.contentItem.findMany({ where: { packId: plan.packId, inListeningList: true }, select: { id: true } });
      total = items.length;
      const itemIds = items.map((i) => i.id);
      const retellItems = await this.prisma.speakingRecord.findMany({
        where: { userId, type: 'RETELL', itemId: { in: itemIds } },
        select: { itemId: true },
        distinct: ['itemId'],
      });
      const readSentences = await this.prisma.speakingRecord.findMany({
        where: { userId, type: 'READ' },
        select: { sentence: { select: { itemId: true } } },
      });
      const readItemSet = new Set(readSentences.map((r) => r.sentence?.itemId).filter((x): x is string => !!x));
      const retellSet = new Set(retellItems.map((r) => r.itemId).filter((x): x is string => !!x));
      // READ 与 RETELL 去重合并
      const covered = new Set([...readItemSet, ...retellSet]);
      done = covered.size;
    }

    const rate = total > 0 ? Math.min(1, done / total) : 0;
    await this.prisma.stage.update({ where: { id: stage.id }, data: { completionRate: rate } });
  }
}
