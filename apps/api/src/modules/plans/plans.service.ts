import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  STAGE_COMPLETION_THRESHOLD,
  StageStatus,
  StageType,
  UNLOCK_MIN_CHECKINS_IN_LAST_7,
} from '@ladder/shared';
import { PrismaService } from '../../prisma/prisma.service';

const STAGE_FLOW: StageType[] = [StageType.LISTEN, StageType.DICTATE, StageType.SPEAK];

const UNLOCK_HINTS: Record<StageType, string> = {
  [StageType.LISTEN]: '',
  [StageType.DICTATE]: `条件：完成听力期天数 + 近 7 天 ≥${UNLOCK_MIN_CHECKINS_IN_LAST_7} 天打卡`,
  [StageType.SPEAK]: `条件：完成听写期天数 + 完成率 ≥${STAGE_COMPLETION_THRESHOLD * 100}%`,
};

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  /** FR-01：创建三阶段计划。阶段一立即激活，其余锁定。 */
  async create(userId: string, dto: { levelCode: string; packId: string; stage1Days: number; stage2Days: number; stage3Days: number }) {
    const pack = await this.prisma.contentPack.findUnique({ where: { id: dto.packId } });
    if (!pack || pack.levelCode !== dto.levelCode) {
      throw new BadRequestException('内容包不存在或不属于所选级别');
    }
    // TODO[待产品确认]：已有进行中计划时的新建策略（当前 409；备选：旧计划标记放弃）
    const active = await this.prisma.plan.findFirst({ where: { userId, status: 'ACTIVE' } });
    if (active) throw new ConflictException('已有进行中的计划，请先完成或调整');

    const today = todayLocal();
    const created = await this.prisma.plan.create({
      data: {
        userId,
        levelCode: dto.levelCode,
        packId: dto.packId,
        stages: {
          create: [
            { type: StageType.LISTEN, seq: 1, status: StageStatus.ACTIVE, plannedDays: dto.stage1Days, startDate: today, endDate: addDays(today, dto.stage1Days) },
            { type: StageType.DICTATE, seq: 2, status: StageStatus.LOCKED, plannedDays: dto.stage2Days },
            { type: StageType.SPEAK, seq: 3, status: StageStatus.LOCKED, plannedDays: dto.stage3Days },
          ],
        },
      },
      include: { stages: { orderBy: { seq: 'asc' } }, pack: { select: { title: true } } },
    });
    // 与 GET /plans/current 保持一致：补 packTitle 与 locked 阶段的 unlockHint
    return this.toDto(created);
  }

  async current(userId: string) {
    const plan = await this.prisma.plan.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { stages: { orderBy: { seq: 'asc' } }, pack: { select: { title: true } } },
    });
    if (!plan) return null;
    return this.toDto(plan);
  }

  /**
   * G1 / P1-5 调整阶段天数：
   * - ACTIVE 阶段：重算 endDate，且不能少于已进行天数
   * - LOCKED 阶段：仅改 plannedDays（startDate/endDate 留到解锁时按当天重算）
   * - DONE/SKIPPED 阶段：禁止修改（历史数据留痕）
   */
  async adjustStage(userId: string, seq: number, plannedDays: number) {
    const plan = await this.mustGetActive(userId);
    const stage = plan.stages.find((s) => s.seq === seq);
    if (!stage) throw new NotFoundException('阶段不存在');
    if (stage.status === StageStatus.DONE || stage.status === StageStatus.SKIPPED) {
      throw new BadRequestException('已完成的阶段不能调整天数');
    }

    if (stage.status === StageStatus.ACTIVE) {
      const start = stage.startDate ?? todayLocal();
      const elapsed = Math.floor((Date.parse(todayLocal()) - Date.parse(start)) / 86400000);
      if (plannedDays < elapsed) throw new BadRequestException(`不能少于已进行的 ${elapsed} 天`);
      await this.prisma.stage.update({
        where: { id: stage.id },
        data: { plannedDays, startDate: start, endDate: addDays(start, plannedDays) },
      });
    } else {
      // LOCKED：只改天数，起止日期在解锁时由 moveToNext 按当天重算
      await this.prisma.stage.update({
        where: { id: stage.id },
        data: { plannedDays },
      });
    }
    return this.current(userId);
  }

  /** G3 最近一个计划（任意状态），用于完成页/重开入口展示 */
  async last(userId: string) {
    const plan = await this.prisma.plan.findFirst({
      where: { userId },
      include: { stages: { orderBy: { seq: 'asc' } }, pack: { select: { title: true } } },
      orderBy: { createdAt: 'desc' },
    });
    if (!plan) return null;
    return this.toDto(plan);
  }

  /** 统一出参：附加阶段解锁提示与内容包标题（含用户自定义包，前端无需再按级别反查） */
  private toDto<T extends { pack: { title: string }; stages: { seq: number; type: string; status: string }[] }>(plan: T) {
    const { pack, stages, ...rest } = plan;
    return {
      ...rest,
      packTitle: pack.title,
      stages: stages.map((s) => ({
        ...s,
        unlockHint: s.status === StageStatus.LOCKED ? UNLOCK_HINTS[s.type as StageType] : null,
      })),
    };
  }

  /** G3 重开计划：沿用最近计划的级别/内容包/各阶段天数，重新从阶段一开始 */
  async restart(userId: string) {
    const active = await this.prisma.plan.findFirst({ where: { userId, status: 'ACTIVE' } });
    if (active) throw new ConflictException('已有进行中的计划，请直接继续或调整天数');

    const lastPlan = await this.prisma.plan.findFirst({
      where: { userId },
      include: { stages: { orderBy: { seq: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    if (!lastPlan) throw new NotFoundException('没有可重开的计划');

    const pack = await this.prisma.contentPack.findUnique({ where: { id: lastPlan.packId }, select: { id: true } });
    if (!pack) throw new BadRequestException('原内容包已删除，请重新创建计划');

    const days = new Map(lastPlan.stages.map((s) => [s.seq, s.plannedDays]));
    const today = todayLocal();
    return this.prisma.plan.create({
      data: {
        userId,
        levelCode: lastPlan.levelCode,
        packId: lastPlan.packId,
        stages: {
          create: [
            { type: StageType.LISTEN, seq: 1, status: StageStatus.ACTIVE, plannedDays: days.get(1) ?? 30, startDate: today, endDate: addDays(today, days.get(1) ?? 30) },
            { type: StageType.DICTATE, seq: 2, status: StageStatus.LOCKED, plannedDays: days.get(2) ?? 60 },
            { type: StageType.SPEAK, seq: 3, status: StageStatus.LOCKED, plannedDays: days.get(3) ?? 30 },
          ],
        },
      },
      include: { stages: { orderBy: { seq: 'asc' } } },
    });
  }

  /** FR-06 自动推进：校验条件 → 当前阶段 DONE → 下一阶段 ACTIVE（阶段三完成则计划 COMPLETED） */
  async advance(userId: string) {
    const plan = await this.mustGetActive(userId);
    const stage = plan.stages.find((s) => s.status === StageStatus.ACTIVE);
    if (!stage) throw new BadRequestException('当前没有进行中的阶段');

    const gap = await this.checkAdvanceGap(userId, stage);
    if (gap) throw new BadRequestException(gap);
    return this.moveToNext(plan.id, stage, StageStatus.DONE);
  }

  /**
   * E3 自动推进：条件全部满足时直接进入下一阶段，否则返回差距文案。
   * 由客户端进入今日页时调用一次（幂等：未达标不会改变任何状态）。
   */
  async autoAdvance(userId: string) {
    const plan = await this.prisma.plan.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { stages: { orderBy: { seq: 'asc' } } },
    });
    const stage = plan?.stages.find((s) => s.status === StageStatus.ACTIVE);
    if (!plan || !stage) return { advanced: false, stageType: null, gap: null };

    const gap = await this.checkAdvanceGap(userId, stage);
    if (gap) return { advanced: false, stageType: stage.type, gap };

    await this.moveToNext(plan.id, stage, StageStatus.DONE);
    return { advanced: true, stageType: stage.type, gap: null };
  }

  /** FR-06 提前切换：不校验条件，当前阶段记 SKIPPED（留痕，客户端先展示条件差距并确认） */
  async skip(userId: string) {
    const plan = await this.mustGetActive(userId);
    const stage = plan.stages.find((s) => s.status === StageStatus.ACTIVE);
    if (!stage) throw new BadRequestException('当前没有进行中的阶段');
    return this.moveToNext(plan.id, stage, StageStatus.SKIPPED);
  }

  /** 返回 null 表示可推进；否则返回用户可见的条件差距文案 */
  private async checkAdvanceGap(userId: string, stage: { type: string; plannedDays: number; startDate: string | null; completionRate: number }): Promise<string | null> {
    const today = todayLocal();
    if (stage.type === StageType.LISTEN) {
      const elapsed = stage.startDate ? Math.floor((Date.parse(today) - Date.parse(stage.startDate)) / 86400000) : 0;
      if (elapsed < stage.plannedDays) return `听力期还差 ${stage.plannedDays - elapsed} 天`;
      const since = addDays(today, -6);
      const checkins = await this.prisma.dailyCheckin.count({
        where: { userId, stageType: StageType.LISTEN, date: { gte: since, lte: today }, done: true },
      });
      if (checkins < UNLOCK_MIN_CHECKINS_IN_LAST_7) return `近 7 天打卡 ${checkins} 天，需 ≥${UNLOCK_MIN_CHECKINS_IN_LAST_7} 天`;
      return null;
    }
    // DICTATE / SPEAK：天数 + 完成率（完成率由 learning 模块写入 stage.completionRate）
    const elapsed = stage.startDate ? Math.floor((Date.parse(today) - Date.parse(stage.startDate)) / 86400000) : 0;
    if (elapsed < stage.plannedDays) return `本阶段还差 ${stage.plannedDays - elapsed} 天`;
    if (stage.completionRate < STAGE_COMPLETION_THRESHOLD) {
      return `完成率 ${Math.round(stage.completionRate * 100)}%，需 ≥${STAGE_COMPLETION_THRESHOLD * 100}%`;
    }
    return null;
  }

  private async moveToNext(planId: string, stage: { id: string; seq: number }, fromStatus: StageStatus) {
    const nextSeq = stage.seq + 1;
    const today = todayLocal();
    const plan = await this.prisma.plan.findUnique({ where: { id: planId }, include: { stages: true } });
    const next = plan?.stages.find((s) => s.seq === nextSeq);

    await this.prisma.stage.update({ where: { id: stage.id }, data: { status: fromStatus } });
    if (next) {
      await this.prisma.stage.update({
        where: { id: next.id },
        data: { status: StageStatus.ACTIVE, startDate: today, endDate: addDays(today, next.plannedDays) },
      });
    } else {
      // 阶段三完成 → 计划完成（FR-06 计划完成页数据由 stats.summary 提供）
      await this.prisma.plan.update({ where: { id: planId }, data: { status: 'COMPLETED', completedAt: new Date() } });
    }
    const updated = await this.prisma.plan.findUnique({
      where: { id: planId },
      include: { stages: { orderBy: { seq: 'asc' } }, pack: { select: { title: true } } },
    });
    return updated ? this.toDto(updated) : null;
  }

  private async mustGetActive(userId: string) {
    const plan = await this.prisma.plan.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { stages: { orderBy: { seq: 'asc' } } },
    });
    if (!plan) throw new NotFoundException('没有进行中的计划');
    return plan;
  }
}
