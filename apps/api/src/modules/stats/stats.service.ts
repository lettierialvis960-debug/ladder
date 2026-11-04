import { BadRequestException, Injectable } from '@nestjs/common';
import {
  RECOVERY_TARGET_DAYS,
  StageStatus,
  StageType,
} from '@ladder/shared';
import type { RecoveryDto } from '@ladder/shared';
import { PrismaService } from '../../prisma/prisma.service';

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** a 到 b 相差天数（b - a，YYYY-MM-DD 本地日期） */
function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/** E2 CSV 单元格转义 */
function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** E2 生成 CSV 文本（带 UTF-8 BOM，Excel 直接打开不乱码） */
function toCsv(rows: unknown[][]): string {
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 今日页：当前阶段的任务卡进度 + 打卡状态 + 连续天数（SR-03） */
  async today(userId: string) {
    const date = todayLocal();
    const goals = await this.goals(userId);
    const plan = await this.prisma.plan.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { stages: { orderBy: { seq: 'asc' } } },
    });
    const stage = plan?.stages.find((s) => s.status === StageStatus.ACTIVE) ?? null;

    let progress = 0;
    let goal = 0;
    let unit: 'minutes' | 'passages' | 'sentences' = 'minutes';
    if (stage?.type === StageType.LISTEN) {
      const agg = await this.prisma.listeningSession.aggregate({ where: { userId, date }, _sum: { effectiveSec: true } });
      progress = Math.floor((agg._sum.effectiveSec ?? 0) / 60);
      goal = goals.listenMin;
      unit = 'minutes';
    } else if (stage?.type === StageType.DICTATE) {
      const attempts = await this.prisma.dictationAttempt.findMany({ where: { userId, date }, select: { sentence: { select: { itemId: true } } } });
      progress = new Set(attempts.map((a) => a.sentence.itemId)).size;
      goal = goals.dictationPassages;
      unit = 'passages';
    } else if (stage?.type === StageType.SPEAK) {
      progress = await this.prisma.speakingRecord.count({ where: { userId, date, type: 'READ' } });
      goal = goals.readSentences; // 复述另计，今日页主卡展示跟读进度
      unit = 'sentences';
    }

    const checkedIn = stage
      ? !!(await this.prisma.dailyCheckin.findUnique({
          where: { userId_date_stageType: { userId, date, stageType: stage.type as StageType } },
        }))
      : false;

    const streakInfo = await this.streakInfo(userId);
    return {
      date,
      stageType: stage?.type ?? null,
      progress,
      goal,
      unit,
      checkedIn,
      streakDays: streakInfo.count,
      recovery: recoveryState(stage, streakInfo),
    };
  }

  /** G2 每日目标读取：默认值来自建库时的 User 字段默认（与 shared 常量一致） */
  async goals(userId: string) {
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

  /** G2 每日目标保存：范围校验在 controller DTO 完成 */
  async updateGoals(userId: string, dto: { listenMin: number; dictationPassages: number; readSentences: number }) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        dailyListenMin: dto.listenMin,
        dailyDictationPassages: dto.dictationPassages,
        dailyReadSentences: dto.readSentences,
      },
    });
    return this.goals(userId);
  }

  /** 日历视图：某月全部打卡记录（断签日由客户端以灰色呈现 + 恢复挑战入口） */
  calendar(userId: string, month: string) {
    return this.prisma.dailyCheckin.findMany({
      where: { userId, date: { startsWith: month } },
      select: { date: true, stageType: true, done: true },
      orderBy: { date: 'asc' },
    });
  }

  /** 计划完成页三项累计数据（FR-06） */
  async summary(userId: string) {
    const [listen, dictation, speaking] = await Promise.all([
      this.prisma.listeningSession.aggregate({ where: { userId }, _sum: { effectiveSec: true } }),
      this.prisma.dictationAttempt.aggregate({ where: { userId }, _count: true, _avg: { correctRate: true } }),
      this.prisma.speakingRecord.count({ where: { userId } }),
    ]);
    return {
      totalListenMin: Math.floor((listen._sum.effectiveSec ?? 0) / 60),
      dictationSentenceCount: dictation._count,
      dictationAvgCorrectRate: dictation._avg.correctRate ?? 0,
      speakingRecordCount: speaking,
    };
  }

  /** A3 学习周报：近 7 日趋势（默认以今天为终点） */
  async weekly(userId: string, endDate?: string) {
    const end = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayLocal();
    const start = addDays(end, -6);
    const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const range = { gte: start, lte: end };

    const [listen, dict, speak, checkins, words, overall, plan] = await Promise.all([
      this.prisma.listeningSession.groupBy({
        by: ['date'], where: { userId, date: range }, _sum: { effectiveSec: true },
      }),
      this.prisma.dictationAttempt.groupBy({
        by: ['date'], where: { userId, date: range }, _count: { id: true }, _avg: { correctRate: true },
      }),
      this.prisma.speakingRecord.groupBy({
        by: ['date'], where: { userId, date: range }, _count: { id: true },
      }),
      this.prisma.dailyCheckin.findMany({ where: { userId, date: range, done: true }, select: { date: true }, distinct: ['date'] }),
      this.prisma.wrongWord.groupBy({
        by: ['word'],
        where: { userId, createdAt: { gte: new Date(start + 'T00:00:00') } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      }),
      this.prisma.dictationAttempt.aggregate({ where: { userId, date: range }, _count: true, _avg: { correctRate: true } }),
      this.prisma.plan.findFirst({
        where: { userId, status: 'ACTIVE' },
        include: { stages: { orderBy: { seq: 'asc' } } },
      }),
    ]);

    const listenBy = new Map(listen.map((r) => [r.date, r._sum.effectiveSec ?? 0]));
    const dictBy = new Map(dict.map((r) => [r.date, r]));
    const speakBy = new Map(speak.map((r) => [r.date, r._count.id]));
    const checked = new Set(checkins.map((c) => c.date));

    const days = dates.map((date) => ({
      date,
      listenMin: Math.floor((listenBy.get(date) ?? 0) / 60),
      dictationCount: dictBy.get(date)?._count.id ?? 0,
      dictationAvgRate: dictBy.get(date)?._avg.correctRate ?? 0,
      speakingCount: speakBy.get(date) ?? 0,
      checkedIn: checked.has(date),
    }));

    const active = plan?.stages.find((s) => s.status === StageStatus.ACTIVE) ?? null;
    return {
      startDate: start,
      endDate: end,
      days,
      totals: {
        listenMin: days.reduce((s, d) => s + d.listenMin, 0),
        dictationCount: overall._count,
        dictationAvgRate: overall._avg.correctRate ?? 0,
        speakingCount: days.reduce((s, d) => s + d.speakingCount, 0),
        checkedDays: days.filter((d) => d.checkedIn).length,
      },
      weakWords: words.map((w) => ({ word: w.word, count: w._count.id })),
      stage: active
        ? {
            type: active.type,
            dayIndex: active.startDate ? Math.min(diffDays(active.startDate, todayLocal()) + 1, active.plannedDays) : 0,
            plannedDays: active.plannedDays,
          }
        : null,
    };
  }

  /**
   * I3 近 N 天学习热力图（默认 30 天）：听力分钟 + 听写句数 + 口语段数折算活跃度。
   * level 0-4 仅用于前端配色，口径固定便于跨天比较。
   */
  async heatmap(userId: string, days = 30) {
    const n = Math.min(90, Math.max(7, Math.floor(days) || 30));
    const end = todayLocal();
    const start = addDays(end, -(n - 1));
    const range = { gte: start, lte: end };

    const [listen, dict, speak, checkins] = await Promise.all([
      this.prisma.listeningSession.groupBy({ by: ['date'], where: { userId, date: range }, _sum: { effectiveSec: true } }),
      this.prisma.dictationAttempt.groupBy({ by: ['date'], where: { userId, date: range }, _count: { id: true } }),
      this.prisma.speakingRecord.groupBy({ by: ['date'], where: { userId, date: range }, _count: { id: true } }),
      this.prisma.dailyCheckin.findMany({ where: { userId, date: range, done: true }, select: { date: true }, distinct: ['date'] }),
    ]);

    const listenBy = new Map(listen.map((r) => [r.date, r._sum.effectiveSec ?? 0]));
    const dictBy = new Map(dict.map((r) => [r.date, r._count.id]));
    const speakBy = new Map(speak.map((r) => [r.date, r._count.id]));
    const checked = new Set(checkins.map((c) => c.date));

    const list = Array.from({ length: n }, (_, i) => {
      const date = addDays(start, i);
      const listenMin = Math.floor((listenBy.get(date) ?? 0) / 60);
      const dictationCount = dictBy.get(date) ?? 0;
      const speakingCount = speakBy.get(date) ?? 0;
      const points = listenMin + dictationCount * 2 + speakingCount * 2;
      const level = points === 0 ? 0 : points < 15 ? 1 : points < 30 ? 2 : points < 60 ? 3 : 4;
      return { date, listenMin, dictationCount, speakingCount, checkedIn: checked.has(date), level };
    });

    return {
      startDate: start,
      endDate: end,
      days: list,
      totals: {
        activeDays: list.filter((d) => d.level > 0).length,
        checkedDays: list.filter((d) => d.checkedIn).length,
        listenMin: list.reduce((s, d) => s + d.listenMin, 0),
        dictationCount: list.reduce((s, d) => s + d.dictationCount, 0),
        speakingCount: list.reduce((s, d) => s + d.speakingCount, 0),
      },
    };
  }

  /**
   * K3 最近学习动态：把听力、听写、错词复习、口语、打卡汇总为统一事件流，
   * 按时间倒序取前 15 条（默认近 7 天）。
   */
  async activity(userId: string, days = 7) {
    const n = Math.min(30, Math.max(1, Math.floor(days) || 7));
    const end = todayLocal();
    const start = addDays(end, -(n - 1));
    const dateRange = { gte: start, lte: end };
    const since = new Date(`${start}T00:00:00`);

    const [listen, dictation, reviews, speaking, checkins] = await Promise.all([
      this.prisma.listeningSession.findMany({
        where: { userId, date: dateRange, effectiveSec: { gt: 0 } },
        select: { date: true, effectiveSec: true, updatedAt: true, item: { select: { title: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      }),
      this.prisma.dictationAttempt.findMany({
        where: { userId, date: dateRange },
        select: {
          date: true,
          correctRate: true,
          createdAt: true,
          sentence: { select: { text: true, item: { select: { title: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.reviewLog.findMany({
        where: { userId, createdAt: { gte: since } },
        select: { word: true, remembered: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.speakingRecord.findMany({
        where: { userId, date: dateRange },
        select: {
          type: true,
          date: true,
          durationSec: true,
          createdAt: true,
          sentence: { select: { item: { select: { title: true } } } },
          item: { select: { title: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.dailyCheckin.findMany({
        where: { userId, date: dateRange, done: true },
        select: { date: true, stageType: true },
        // 同日多阶段打卡共用 12:00 的占位时间，按阶段固定顺序保证时间线稳定
        orderBy: [{ date: 'desc' }, { stageType: 'asc' }],
      }),
    ]);

    const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const stageLabel: Record<string, string> = { LISTEN: '阶段一打卡', DICTATE: '阶段二打卡', SPEAK: '阶段三打卡' };
    const clip = (text: string) => (text.length > 32 ? `${text.slice(0, 32)}…` : text);

    const events = [
      ...listen.map((r) => ({
        type: 'listen' as const,
        label: `有效听力 ${Math.floor(r.effectiveSec / 60)} 分钟`,
        detail: `《${r.item.title}》`,
        date: r.date,
        createdAt: r.updatedAt.toISOString(),
      })),
      ...dictation.map((r) => ({
        type: 'dictation' as const,
        label: `听写一句 · 正确率 ${Math.round(r.correctRate * 100)}%`,
        detail: `${clip(r.sentence.text)} · 《${r.sentence.item.title}》`,
        date: r.date,
        createdAt: r.createdAt.toISOString(),
      })),
      ...reviews.map((r) => ({
        type: 'review' as const,
        label: r.remembered ? '错词复习 · 记住了' : '错词复习 · 再练一次',
        detail: r.word,
        date: localDay(r.createdAt),
        createdAt: r.createdAt.toISOString(),
      })),
      ...speaking.map((r) => ({
        type: 'speaking' as const,
        label: r.type === 'READ' ? '跟读录音' : '复述录音',
        detail: `《${r.item?.title ?? r.sentence?.item.title ?? '未知材料'}》 · ${r.durationSec} 秒`,
        date: r.date,
        createdAt: r.createdAt.toISOString(),
      })),
      ...checkins.map((r) => ({
        type: 'checkin' as const,
        label: stageLabel[r.stageType] ?? '阶段打卡',
        detail: r.date,
        date: r.date,
        // 打卡无创建时间，用当日中午占位；排序时按「同日打卡排在最后」处理
        createdAt: new Date(`${r.date}T12:00:00`).toISOString(),
      })),
    ]
      // 先按日期倒序；同日内打卡排在最后，其余按创建时间倒序
      .sort((a, b) => b.date.localeCompare(a.date)
        || Number(a.type === 'checkin') - Number(b.type === 'checkin')
        || b.createdAt.localeCompare(a.createdAt));

    return { startDate: start, endDate: end, events: events.slice(0, 15) };
  }

  /**
   * C2 成就徽章：由已有学习数据实时推导（不落库，避免维护状态机）。
   * 徽章按类别分组，progress 为当前值、target 为达成门槛。
   */
  async achievements(userId: string) {
    const [streak, listen, dictation, speaking, masteredWords, doneStages, donePlans] = await Promise.all([
      this.streakInfo(userId),
      this.prisma.listeningSession.aggregate({ where: { userId }, _sum: { effectiveSec: true } }),
      this.prisma.dictationAttempt.count({ where: { userId } }),
      this.prisma.speakingRecord.count({ where: { userId } }),
      this.prisma.wrongWord.count({ where: { userId, mastered: true } }),
      this.prisma.stage.count({ where: { plan: { userId }, status: StageStatus.DONE } }),
      this.prisma.plan.count({ where: { userId, status: 'COMPLETED' } }),
    ]);

    const listenMin = Math.floor((listen._sum.effectiveSec ?? 0) / 60);
    const defs: {
      key: string; title: string; description: string; target: number; progress: number;
      category: 'streak' | 'listen' | 'dictation' | 'speaking' | 'review' | 'plan';
    }[] = [
      { key: 'streak7', title: '小有坚持', description: '连续打卡 7 天', target: 7, progress: streak.count, category: 'streak' },
      { key: 'streak30', title: '月度自律', description: '连续打卡 30 天', target: 30, progress: streak.count, category: 'streak' },
      { key: 'listen10h', title: '耳朵打开', description: '累计有效听力 10 小时', target: 600, progress: listenMin, category: 'listen' },
      { key: 'listen50h', title: '沉浸听力', description: '累计有效听力 50 小时', target: 3000, progress: listenMin, category: 'listen' },
      { key: 'dictation100', title: '听写百句', description: '累计听写 100 句', target: 100, progress: dictation, category: 'dictation' },
      { key: 'dictation500', title: '听写五百句', description: '累计听写 500 句', target: 500, progress: dictation, category: 'dictation' },
      { key: 'speaking50', title: '开口 50 段', description: '累计口语录音 50 段', target: 50, progress: speaking, category: 'speaking' },
      { key: 'words20', title: '错词清零', description: '掌握 20 个错词', target: 20, progress: masteredWords, category: 'review' },
      { key: 'stage1', title: '阶段达成', description: '完成第一个阶段', target: 1, progress: doneStages, category: 'plan' },
      { key: 'plan1', title: '三步走完', description: '完成一个完整计划', target: 1, progress: donePlans, category: 'plan' },
    ];

    const items = defs.map((d) => ({
      ...d,
      progress: Math.min(d.progress, d.target),
      unlocked: d.progress >= d.target,
    }));
    return {
      unlockedCount: items.filter((i) => i.unlocked).length,
      total: items.length,
      items,
    };
  }

  /** E2 学习数据导出：全量 JSON 备份（计划/打卡/听写/听力/口语/错词/标记/收藏/对话） */
  async exportAll(userId: string) {
    const [user, plans, checkins, listening, dictation, speaking, wrongWords, confused, favorites, dialogue] =
      await Promise.all([
        this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, createdAt: true } }),
        this.prisma.plan.findMany({
          where: { userId },
          include: { stages: { orderBy: { seq: 'asc' } } },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.dailyCheckin.findMany({ where: { userId }, orderBy: { date: 'asc' } }),
        this.prisma.listeningSession.findMany({
          where: { userId },
          include: { item: { select: { title: true } } },
          orderBy: { date: 'asc' },
        }),
        this.prisma.dictationAttempt.findMany({
          where: { userId },
          include: { sentence: { select: { text: true, item: { select: { title: true } } } } },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.speakingRecord.findMany({
          where: { userId },
          include: { sentence: { select: { text: true } }, item: { select: { title: true } } },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.wrongWord.findMany({
          where: { userId },
          include: { sentence: { select: { text: true, translation: true } } },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.confusedMark.findMany({
          where: { userId },
          include: { sentence: { select: { text: true } } },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.favoriteSentence.findMany({
          where: { userId },
          include: { sentence: { select: { text: true } } },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.dialogueSession.findMany({
          where: { userId },
          include: { messages: { orderBy: { createdAt: 'asc' } } },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

    return {
      exportedAt: new Date().toISOString(),
      user,
      plans,
      checkins,
      listeningSessions: listening,
      dictationAttempts: dictation,
      speakingRecords: speaking,
      wrongWords,
      confusedMarks: confused,
      favorites,
      dialogueSessions: dialogue,
    };
  }

  /** E2 学习数据导出：单表 CSV（dictation / wrong-words / checkins / favorites / wrong-words-anki） */
  async exportCsv(userId: string, entity: string, filters: { itemId?: string; from?: string; to?: string } = {}) {
    if (entity === 'dictation') {
      const list = await this.prisma.dictationAttempt.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        include: { sentence: { select: { text: true, item: { select: { title: true } } } } },
      });
      const rows: unknown[][] = [['日期', '材料', '句子', '我的输入', '正确率(0-1)', '重听次数', '提交时间']];
      list.forEach((a) =>
        rows.push([a.date, a.sentence.item.title, a.sentence.text, a.input, a.correctRate, a.replayCount, a.createdAt.toISOString()]),
      );
      return toCsv(rows);
    }

    if (entity === 'wrong-words') {
      const list = await this.prisma.wrongWord.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        include: { sentence: { select: { text: true, translation: true } } },
      });
      const rows: unknown[][] = [['单词', '原句', '译文', '已掌握', '连续记住次数', '下次到期', '首次出错时间']];
      list.forEach((w) =>
        rows.push([w.word, w.sentence.text, w.sentence.translation, w.mastered ? '是' : '否', w.reviewCount, w.dueAt.toISOString(), w.createdAt.toISOString()]),
      );
      return toCsv(rows);
    }

    if (entity === 'checkins') {
      const list = await this.prisma.dailyCheckin.findMany({
        where: { userId },
        orderBy: { date: 'asc' },
      });
      const rows: unknown[][] = [['日期', '阶段', '是否完成']];
      list.forEach((c) => rows.push([c.date, c.stageType, c.done ? '是' : '否']));
      return toCsv(rows);
    }

    // F1 收藏句导出为 Anki 可导入的 CSV：Front = 原句、Back = 译文
    if (entity === 'favorites') {
      const list = await this.prisma.favoriteSentence.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        include: {
          sentence: { select: { text: true, translation: true, audioUrl: true, item: { select: { title: true } } } },
        },
      });
      const rows: unknown[][] = [['Front', 'Back', '材料', '音频路径', '收藏时间']];
      list.forEach((f) =>
        rows.push([f.sentence.text, f.sentence.translation, f.sentence.item.title, f.sentence.audioUrl, f.createdAt.toISOString()]),
      );
      return toCsv(rows);
    }

    // H1 错词本导出为 Anki CSV：Front = 单词、Back = 原句 + 译文，支持材料/日期筛选
    if (entity === 'wrong-words-anki') {
      const dateOk = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
      const createdAt: { gte?: Date; lte?: Date } = {};
      if (dateOk(filters.from)) createdAt.gte = new Date(`${filters.from}T00:00:00`);
      if (dateOk(filters.to)) createdAt.lte = new Date(`${filters.to}T23:59:59.999`);
      const list = await this.prisma.wrongWord.findMany({
        where: {
          userId,
          ...(filters.itemId ? { sentence: { itemId: filters.itemId } } : {}),
          ...(createdAt.gte || createdAt.lte ? { createdAt } : {}),
        },
        orderBy: { createdAt: 'asc' },
        include: {
          sentence: { select: { text: true, translation: true, item: { select: { title: true } } } },
        },
      });
      const rows: unknown[][] = [['Front', 'Back', '材料', '下次到期', '首次出错']];
      list.forEach((w) =>
        rows.push([
          w.word,
          `${w.sentence.text} / ${w.sentence.translation}`,
          w.sentence.item.title,
          w.dueAt.toISOString(),
          w.createdAt.toISOString(),
        ]),
      );
      return toCsv(rows);
    }

    throw new BadRequestException('不支持的导出类型，可选 dictation / wrong-words / checkins / favorites / wrong-words-anki');
  }

  /**
   * F3 数据导入恢复：恢复打卡 / 错词 / 收藏 / 没听懂标记。
   * 只恢复当前内容库仍存在的句子；按自然键去重，重复导入不会产生重复记录。
   */
  async importData(userId: string, payload: unknown) {
    if (!payload || typeof payload !== 'object') throw new BadRequestException('导入文件格式不正确');
    const data = payload as Record<string, unknown>;
    const rowsOf = (v: unknown) => (Array.isArray(v) ? v.slice(0, 2000) : []);
    const checkins = rowsOf(data.checkins);
    const wrongWords = rowsOf(data.wrongWords);
    const favorites = rowsOf(data.favorites);
    const confused = rowsOf(data.confusedMarks);
    if (!checkins.length && !wrongWords.length && !favorites.length && !confused.length) {
      throw new BadRequestException('导入文件中没有可恢复的学习记录');
    }

    // 过滤当前内容库已不存在的句子（例如被删除的自定义材料）
    const ids = new Set<string>();
    const addId = (v: unknown) => { if (typeof v === 'string') ids.add(v); };
    wrongWords.forEach((r) => { const x = r as Record<string, any>; addId(x?.sentenceId ?? x?.sentence?.id); });
    favorites.forEach((r) => { const x = r as Record<string, any>; addId(x?.sentenceId ?? x?.sentence?.id); });
    confused.forEach((r) => { const x = r as Record<string, any>; addId(x?.sentenceId ?? x?.sentence?.id); });
    const alive = new Set(
      (await this.prisma.sentence.findMany({ where: { id: { in: [...ids] } }, select: { id: true } })).map((s) => s.id),
    );

    let skipped = 0;
    let c = 0;
    let w = 0;
    let f = 0;
    let m = 0;

    for (const raw of checkins) {
      const r = raw as Record<string, any>;
      const date = typeof r?.date === 'string' ? r.date : '';
      const stageType = typeof r?.stageType === 'string' ? r.stageType : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['LISTEN', 'DICTATE', 'SPEAK'].includes(stageType)) {
        skipped += 1; continue;
      }
      const exists = await this.prisma.dailyCheckin.findUnique({
        where: { userId_date_stageType: { userId, date, stageType: stageType as 'LISTEN' | 'DICTATE' | 'SPEAK' } },
      });
      if (exists) { skipped += 1; continue; }
      await this.prisma.dailyCheckin.create({
        data: { userId, date, stageType: stageType as 'LISTEN' | 'DICTATE' | 'SPEAK', done: r.done !== false },
      });
      c += 1;
    }

    for (const raw of wrongWords) {
      const r = raw as Record<string, any>;
      const word = typeof r?.word === 'string' ? r.word.trim() : '';
      const sentenceId = typeof r?.sentenceId === 'string' ? r.sentenceId : (typeof r?.sentence?.id === 'string' ? r.sentence.id : '');
      if (!word || !sentenceId || !alive.has(sentenceId)) { skipped += 1; continue; }
      const exists = await this.prisma.wrongWord.findFirst({ where: { userId, word, sentenceId } });
      if (exists) { skipped += 1; continue; }
      const dueMs = typeof r?.dueAt === 'string' ? Date.parse(r.dueAt) : NaN;
      await this.prisma.wrongWord.create({
        data: {
          userId,
          word,
          sentenceId,
          mastered: r.mastered === true,
          reviewCount: Number.isInteger(r.reviewCount) ? r.reviewCount : 0,
          dueAt: Number.isNaN(dueMs) ? new Date() : new Date(dueMs),
        },
      });
      w += 1;
    }

    for (const raw of favorites) {
      const r = raw as Record<string, any>;
      const sentenceId = typeof r?.sentenceId === 'string' ? r.sentenceId : (typeof r?.sentence?.id === 'string' ? r.sentence.id : '');
      if (!sentenceId || !alive.has(sentenceId)) { skipped += 1; continue; }
      const exists = await this.prisma.favoriteSentence.findUnique({
        where: { userId_sentenceId: { userId, sentenceId } },
      });
      if (exists) { skipped += 1; continue; }
      await this.prisma.favoriteSentence.create({ data: { userId, sentenceId } });
      f += 1;
    }

    for (const raw of confused) {
      const r = raw as Record<string, any>;
      const sentenceId = typeof r?.sentenceId === 'string' ? r.sentenceId : (typeof r?.sentence?.id === 'string' ? r.sentence.id : '');
      if (!sentenceId || !alive.has(sentenceId)) { skipped += 1; continue; }
      const exists = await this.prisma.confusedMark.findUnique({
        where: { userId_sentenceId: { userId, sentenceId } },
      });
      if (exists) { skipped += 1; continue; }
      await this.prisma.confusedMark.create({
        data: { userId, sentenceId, resolved: r.resolved === true },
      });
      m += 1;
    }

    return { checkins: c, wrongWords: w, favorites: f, confusedMarks: m, skipped };
  }

  /** SR-03：连续打卡信息（从今天/昨天向前逐日回推，断 1 天即清零；附最近打卡日与是否存在历史断档） */
  private async streakInfo(userId: string): Promise<{ count: number; lastDate: string | null; hadPrior: boolean }> {
    const rows = await this.prisma.dailyCheckin.findMany({
      where: { userId, done: true },
      select: { date: true },
      distinct: ['date'],
      orderBy: { date: 'desc' },
    });
    const days = new Set(rows.map((r) => r.date));
    const lastDate = rows[0]?.date ?? null;
    let cursor = todayLocal();
    if (!days.has(cursor)) {
      // 今天还没打卡不算断签，从昨天开始数
      cursor = addDays(cursor, -1);
    }
    let count = 0;
    while (days.has(cursor)) {
      count++;
      cursor = addDays(cursor, -1);
    }
    // 当前连续段之外还有更早的打卡 → 存在过一次断档（用于区分“新用户首段连续”与“断签后恢复”）
    return { count, lastDate, hadPrior: days.size > count };
  }
}

/** SR-03 恢复挑战状态推导（纯函数，便于单测） */
function recoveryState(
  stage: { type: string; startDate: string | null } | null,
  streak: { count: number; lastDate: string | null; hadPrior: boolean },
): RecoveryDto {
  const none: RecoveryDto = { state: 'NONE', breakDays: 0, targetDays: RECOVERY_TARGET_DAYS };
  if (!stage) return none;
  const today = todayLocal();
  const yesterday = addDays(today, -1);

  // 断签判定：最近打卡早于昨天；或阶段已开始却从未打卡
  if (streak.lastDate && streak.lastDate < yesterday) {
    return { state: 'BROKEN', breakDays: diffDays(streak.lastDate, yesterday), targetDays: RECOVERY_TARGET_DAYS };
  }
  if (!streak.lastDate && stage.startDate && stage.startDate < today) {
    return { state: 'BROKEN', breakDays: diffDays(stage.startDate, today), targetDays: RECOVERY_TARGET_DAYS };
  }
  // 恢复中：断档后重新建立连续段，但未达挑战目标
  if (streak.count > 0 && streak.count < RECOVERY_TARGET_DAYS && streak.hadPrior) {
    return { state: 'RECOVERING', breakDays: 0, targetDays: RECOVERY_TARGET_DAYS };
  }
  return none;
}
