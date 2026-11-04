import { Body, Controller, Get, Header, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StatsService } from './stats.service';

class GoalsDto {
  @IsInt() @Min(10) @Max(240) listenMin: number;
  @IsInt() @Min(1) @Max(10) dictationPassages: number;
  @IsInt() @Min(1) @Max(100) readSentences: number;
}

/** FR-07 学习记录与统计 */
@UseGuards(JwtAuthGuard)
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  /** GET /api/stats/today —— 今日任务进度 + 连续打卡天数（今日页数据源） */
  @Get('today')
  today(@CurrentUser() userId: string) {
    return this.stats.today(userId);
  }

  /** G2 GET /api/stats/goals —— 每日目标 */
  @Get('goals')
  goals(@CurrentUser() userId: string) {
    return this.stats.goals(userId);
  }

  /** G2 PUT /api/stats/goals —— 保存每日目标（影响自动打卡判定） */
  @Put('goals')
  updateGoals(@CurrentUser() userId: string, @Body() dto: GoalsDto) {
    return this.stats.updateGoals(userId, dto);
  }

  /** GET /api/stats/calendar?month=2026-10 —— 日历视图打卡记录 */
  @Get('calendar')
  calendar(@CurrentUser() userId: string, @Query('month') month: string) {
    return this.stats.calendar(userId, month);
  }

  /** A3 GET /api/stats/weekly?endDate=YYYY-MM-DD —— 近 7 日学习周报 */
  @Get('weekly')
  weekly(@CurrentUser() userId: string, @Query('endDate') endDate?: string) {
    return this.stats.weekly(userId, endDate);
  }

  /** I3 GET /api/stats/heatmap?days=30 —— 近 N 天学习热力图 */
  @Get('heatmap')
  heatmap(@CurrentUser() userId: string, @Query('days') days?: string) {
    return this.stats.heatmap(userId, Number(days));
  }

  /** K3 GET /api/stats/activity?days=7 —— 最近学习动态时间线 */
  @Get('activity')
  activity(@CurrentUser() userId: string, @Query('days') days?: string) {
    return this.stats.activity(userId, Number(days));
  }

  /** GET /api/stats/summary —— 计划完成页三项累计数据（FR-06） */
  @Get('summary')
  summary(@CurrentUser() userId: string) {
    return this.stats.summary(userId);
  }

  /** C2 GET /api/stats/achievements —— 成就徽章（由学习数据实时推导） */
  @Get('achievements')
  achievements(@CurrentUser() userId: string) {
    return this.stats.achievements(userId);
  }

  /** E2 GET /api/stats/export —— 全量学习数据（JSON 备份） */
  @Get('export')
  exportAll(@CurrentUser() userId: string) {
    return this.stats.exportAll(userId);
  }

  /** E2 GET /api/stats/export/csv?entity=dictation|wrong-words|checkins —— 单表 CSV */
  @Get('export/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  exportCsv(
    @CurrentUser() userId: string,
    @Query('entity') entity: string,
    @Query('itemId') itemId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.stats.exportCsv(userId, entity, { itemId, from, to });
  }

  /** F3 POST /api/stats/import —— 从全量备份恢复学习记录（幂等去重） */
  @Post('import')
  importData(@CurrentUser() userId: string, @Body() body: unknown) {
    return this.stats.importData(userId, body);
  }
}
