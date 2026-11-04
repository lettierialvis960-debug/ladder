import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsString, Max, Min } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlansService } from './plans.service';

class CreatePlanDto {
  @IsIn(['L1', 'L2', 'L3']) levelCode: string;
  @IsString() packId: string;
  @IsInt() @IsIn([30, 45, 60]) stage1Days: number; // FR-01：方法论 1–2 个月
  @IsInt() @IsIn([30, 60, 90]) stage2Days = 60;    // 决策 D4：默认 60
  @IsInt() @Min(30) @Max(90) stage3Days = 30;      // 暂定值
}

class AdjustStageDto {
  @IsInt() @Min(15) @Max(180) plannedDays: number;
}

/** FR-01 建计划 / FR-06 阶段推进。全部需登录。 */
@UseGuards(JwtAuthGuard)
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Post()
  create(@CurrentUser() userId: string, @Body() dto: CreatePlanDto) {
    return this.plans.create(userId, dto);
  }

  @Get('current')
  current(@CurrentUser() userId: string) {
    return this.plans.current(userId);
  }

  /** G1 PATCH /api/plans/current/stages/:seq —— 调整进行中阶段的天数 */
  @Patch('current/stages/:seq')
  adjustStage(
    @CurrentUser() userId: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Body() dto: AdjustStageDto,
  ) {
    return this.plans.adjustStage(userId, seq, dto.plannedDays);
  }

  /** G3 GET /api/plans/last —— 最近一个计划（含已完成），用于重开入口 */
  @Get('last')
  last(@CurrentUser() userId: string) {
    return this.plans.last(userId);
  }

  /** G3 POST /api/plans/restart —— 沿用最近计划配置重新开始 */
  @Post('restart')
  restart(@CurrentUser() userId: string) {
    return this.plans.restart(userId);
  }

  /** FR-06：满足自动条件后推进到下一阶段（系统调用/客户端触发均可） */
  @Post('current/advance')
  advance(@CurrentUser() userId: string) {
    return this.plans.advance(userId);
  }

  /** E3：进入今日页时调用，条件达标则自动推进（幂等） */
  @Post('current/auto-advance')
  autoAdvance(@CurrentUser() userId: string) {
    return this.plans.autoAdvance(userId);
  }

  /** FR-06：用户提前切换（留痕 SKIPPED，客户端需先确认条件差距） */
  @Post('current/skip')
  skip(@CurrentUser() userId: string) {
    return this.plans.skip(userId);
  }
}
