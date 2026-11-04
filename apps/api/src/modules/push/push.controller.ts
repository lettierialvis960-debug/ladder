import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional, IsString, Matches } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PushService } from './push.service';

class SubscribeDto {
  @IsString() endpoint: string;
  @IsObject() keys: { p256dh: string; auth: string };
}

class UnsubscribeDto {
  @IsString() endpoint: string;
}

class ReminderSettingsDto {
  @IsBoolean() @IsOptional() reminderEnabled?: boolean;
  @Matches(/^\d{2}:\d{2}$/, { message: 'reminderTime 需为 HH:mm' }) @IsOptional() reminderTime?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  /** VAPID 公钥（订阅前获取，无需登录也行，这里统一走鉴权） */
  @Get('vapid-public-key')
  vapidPublicKey() {
    return { publicKey: this.push.vapidPublicKey };
  }

  /** 上报浏览器 PushSubscription（每设备一条，endpoint 幂等） */
  @Post('subscribe')
  subscribe(@CurrentUser() userId: string, @Body() dto: SubscribeDto) {
    return this.push.subscribe(userId, dto);
  }

  /** 解绑设备 */
  @Post('unsubscribe')
  unsubscribe(@CurrentUser() userId: string, @Body() dto: UnsubscribeDto) {
    return this.push.unsubscribe(userId, dto.endpoint);
  }

  @Get('settings')
  settings(@CurrentUser() userId: string) {
    return this.push.settings(userId);
  }

  @Put('settings')
  updateSettings(@CurrentUser() userId: string, @Body() dto: ReminderSettingsDto) {
    return this.push.updateSettings(userId, dto);
  }

  /** 立即向本人所有设备发测试通知 */
  @Post('test')
  test(@CurrentUser() userId: string) {
    return this.push.sendToUser(userId, {
      title: 'Ladder 测试通知',
      body: '推送通道已就绪，到点会提醒你来学习。',
      url: '/',
    });
  }
}
