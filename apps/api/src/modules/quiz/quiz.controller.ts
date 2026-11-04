import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { QuizService } from './quiz.service';
import type { QuizSubmitInput } from '@ladder/shared';

@Controller('quiz')
@UseGuards(JwtAuthGuard)
export class QuizController {
  constructor(private readonly quiz: QuizService) {}

  /** P1-3 生成分级小测 */
  @Get('generate')
  generate(@CurrentUser('sub') userId: string, @Query('levelCode') levelCode: string, @Query('count') count?: string) {
    return this.quiz.generate(userId, levelCode, count ? Number(count) : undefined);
  }

  /** 查看小测（未提交时返回题目；提交后返回成绩） */
  @Get(':id')
  get(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.quiz.getSession(userId, id);
  }

  /** 提交答案并判分 */
  @Post(':id/submit')
  submit(@CurrentUser('sub') userId: string, @Param('id') id: string, @Body() body: QuizSubmitInput) {
    return this.quiz.submit(userId, id, body.answers ?? []);
  }

  /** 历史小测成绩 */
  @Get('history/list')
  history(@CurrentUser('sub') userId: string) {
    return this.quiz.history(userId);
  }
}
