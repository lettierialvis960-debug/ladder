import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DialogueService } from './dialogue.service';

class CreateSessionDto {
  @IsString() scenarioKey: string;
}

class SendTurnDto {
  /** 客户端已通过 POST /learning/uploads 上传的录音 URL（本地 /uploads/xxx 或对象存储 CDN 地址） */
  @IsString() audioUrl: string;
  /** 开发期桩 ASR 的模拟识别结果；接入真实 ASR 后不再使用 */
  @IsOptional() @IsString() @MaxLength(500) devTranscript?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('dialogue')
export class DialogueController {
  constructor(private readonly dialogue: DialogueService) {}

  /** 场景目录 */
  @Get('scenarios')
  scenarios() {
    return this.dialogue.listScenarios();
  }

  /** 开新会话（阶段三解锁校验在其中） */
  @Post('sessions')
  create(@CurrentUser() userId: string, @Body() dto: CreateSessionDto) {
    return this.dialogue.createSession(userId, dto.scenarioKey);
  }

  /** 会话详情（含历史消息） */
  @Get('sessions/:id')
  detail(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.dialogue.getSession(userId, id);
  }

  /** 一轮对话：录音 URL 由 service 层通过 StorageService 读取 → 转写 → 回复 → 语音 */
  @Post('sessions/:id/turn')
  turn(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: SendTurnDto) {
    return this.dialogue.sendTurn(userId, id, {
      audioUrl: dto.audioUrl,
      devTranscript: dto.devTranscript,
    });
  }

  /** 结束会话并返回小结 */
  @Post('sessions/:id/end')
  end(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.dialogue.endSession(userId, id);
  }
}
