import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import webpush from 'web-push';
import { PrismaService } from '../../prisma/prisma.service';

const REMINDER_TITLE = 'Ladder 学习提醒';

/**
 * P1 提醒推送（Web Push / VAPID）。
 * 每分钟 tick：到点(reminderTime) + 当天未提醒 + 今日任务未完成 → 推送学习提醒。
 * 失效订阅（404/410）自动清理。VAPID 密钥缺失时功能静默降级（supported=false）。
 */
@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private readonly publicKey = process.env.VAPID_PUBLIC_KEY ?? '';
  private readonly privateKey = process.env.VAPID_PRIVATE_KEY ?? '';

  constructor(private readonly prisma: PrismaService) {
    if (this.enabled) {
      webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:dev@ladder.local', this.publicKey, this.privateKey);
    }
  }

  get enabled() {
    return Boolean(this.publicKey && this.privateKey);
  }

  /** 对外暴露的 VAPID 公钥（未配置时为空串） */
  get vapidPublicKey() {
    return this.enabled ? this.publicKey : '';
  }

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  subscribe(userId: string, dto: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    return this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: { userId, endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
      update: { userId, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
    });
  }

  async unsubscribe(userId: string, endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
    return { ok: true };
  }

  async settings(userId: string) {
    const sub = await this.prisma.pushSubscription.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return {
      supported: this.enabled,
      subscribed: Boolean(sub),
      reminderEnabled: sub?.reminderEnabled ?? true,
      reminderTime: sub?.reminderTime ?? '20:00',
    };
  }

  async updateSettings(userId: string, dto: { reminderEnabled?: boolean; reminderTime?: string }) {
    await this.prisma.pushSubscription.updateMany({ where: { userId }, data: dto });
    return this.settings(userId);
  }

  /** 向用户全部设备推送，返回逐条投递结果 */
  async sendToUser(userId: string, payload: { title: string; body: string; url?: string }) {
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    const results = await Promise.all(subs.map((s) => this.send(s, payload)));
    return { sent: results.filter((r) => r.ok).length, results };
  }

  private async send(
    sub: { id: string; endpoint: string; p256dh: string; auth: string },
    payload: { title: string; body: string; url?: string },
  ) {
    if (!this.enabled) return { ok: false, error: 'VAPID keys not configured' };
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      );
      return { ok: true, endpoint: sub.endpoint };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await this.prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      }
      return { ok: false, endpoint: sub.endpoint, error: String((e as Error).message ?? e) };
    }
  }

  /** 每分钟扫描：reminderTime 已到 + 今天没提醒过 + 今日任务未完成 */
  private async tick() {
    if (!this.enabled) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // 注意：不能用 NOT: { lastRemindedDate: today } —— SQL 三值逻辑下会连
    // lastRemindedDate IS NULL（从未提醒）的行一并过滤，导致首提醒永远不触发。
    const due = await this.prisma.pushSubscription.findMany({
      where: {
        reminderEnabled: true,
        reminderTime: { lte: hhmm },
        OR: [{ lastRemindedDate: null }, { lastRemindedDate: { not: today } }],
      },
      take: 100,
    });

    for (const sub of due) {
      if (!(await this.pendingToday(sub.userId, today))) {
        // 无进行中任务可提醒：记为已处理，避免之后每分钟重复扫描
        await this.prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastRemindedDate: today } });
        continue;
      }
      const r = await this.send(sub, { title: REMINDER_TITLE, body: '今天的任务还没完成，去练一会儿吧！', url: '/' });
      if (r.ok) {
        await this.prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastRemindedDate: today } });
      }
    }
  }

  /** 今天是否有进行中阶段且未打卡 */
  private async pendingToday(userId: string, today: string): Promise<boolean> {
    const plan = await this.prisma.plan.findFirst({ where: { userId, status: 'ACTIVE' }, include: { stages: true } });
    const activeStage = plan?.stages.find((s) => s.status === 'ACTIVE');
    if (!activeStage) return false;
    const checkin = await this.prisma.dailyCheckin.findUnique({
      where: { userId_date_stageType: { userId, date: today, stageType: activeStage.type } },
    });
    return !checkin?.done;
  }
}
