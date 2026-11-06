import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LearningService } from './learning.service';
import { StorageService } from '../../common/storage/storage.interface';

class ReportListeningDto {
  @IsString() itemId: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date: string; // YYYY-MM-DD（SR-02 本地日期）
  @IsInt() @Min(1) @Max(3600) effectiveSec: number; // 单次上报上限防异常包
}

class DictationAttemptDto {
  @IsString() sentenceId: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date: string;
  @IsString() input: string;
  @IsNumber() @Min(0) @Max(1) correctRate: number;
  @IsInt() @Min(0) replayCount: number;
  @IsArray() @IsString({ each: true }) wrongWords: string[];
}

class SpeakingRecordDto {
  @IsIn(['READ', 'RETELL']) type: 'READ' | 'RETELL';
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date: string;
  @IsOptional() @IsString() sentenceId?: string; // READ 必填（service 校验）
  @IsOptional() @IsString() itemId?: string;     // RETELL 必填
  @IsString() audioUrl: string;
  @IsInt() @Min(1) durationSec: number;
  @IsOptional() @IsNumber() score?: number;
  /** 可选：前端 Web Speech API ASR 识别文本，用于词级 WER 评分（Chrome/Edge） */
  @IsOptional() @IsString() transcript?: string;
}

class ConfusedMarkDto {
  @IsString() sentenceId: string;
}

class ReviewWrongWordDto {
  /** true = 记住了（推进 SRS）；false = 再练一次（归零重排） */
  @IsBoolean() remembered: boolean;
}

class RateSpeakingDto {
  /** D1 自评星级 1~5 */
  @IsInt() @Min(1) @Max(5) rating: number;
}

class FavoriteDto {
  @IsString() sentenceId: string;
}

class BatchWrongWordDto {
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) ids: string[];
  @IsIn(['mastered', 'delete']) action: 'mastered' | 'delete';
}

class BatchResolvedConfusedDto {
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) ids: string[];
}

@UseGuards(JwtAuthGuard)
@Controller('learning')
export class LearningController {
  constructor(
    private readonly learning: LearningService,
    private readonly storage: StorageService,
  ) {}

  /** SR-01：客户端 tracker 过滤后的有效听时长上报（幂等，按日聚合 + 单日封顶） */
  @Post('listening')
  reportListening(@CurrentUser() userId: string, @Body() dto: ReportListeningDto) {
    return this.learning.reportListening(userId, dto);
  }

  /** FR-04：单句听写结果（批改在客户端 dictationGrader 完成，服务端留档 + 错词本） */
  @Post('dictation')
  saveDictation(@CurrentUser() userId: string, @Body() dto: DictationAttemptDto) {
    return this.learning.saveDictation(userId, dto);
  }

  /** FR-05：口语记录（录音先走 /uploads 拿 URL） */
  @Post('speaking')
  saveSpeaking(@CurrentUser() userId: string, @Body() dto: SpeakingRecordDto) {
    return this.learning.saveSpeaking(userId, dto);
  }

  /** F2 GET /api/learning/favorites —— 收藏的句子 */
  @Get('favorites')
  favorites(@CurrentUser() userId: string) {
    return this.learning.favoriteSentences(userId);
  }

  /** F2 POST /api/learning/favorites —— 收藏句子（幂等） */
  @Post('favorites')
  addFavorite(@CurrentUser() userId: string, @Body() dto: FavoriteDto) {
    return this.learning.addFavorite(userId, dto.sentenceId);
  }

  /** F2 DELETE /api/learning/favorites/:sentenceId —— 取消收藏（幂等） */
  @Delete('favorites/:sentenceId')
  removeFavorite(@CurrentUser() userId: string, @Param('sentenceId') sentenceId: string) {
    return this.learning.removeFavorite(userId, sentenceId);
  }

  /** D1：对照回放后的自评星级（写入本人录音记录） */
  @Post('speaking/:id/rating')
  rateSpeaking(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: RateSpeakingDto) {
    return this.learning.rateSpeaking(userId, id, dto.rating);
  }

  /** P1 错词本：待复习列表（未掌握 + 原句） */
  @Get('wrong-words')
  wrongWords(@CurrentUser() userId: string) {
    return this.learning.wrongWords(userId);
  }

  /** P1 错词本：标记已掌握 */
  @Post('wrong-words/:id/mastered')
  masterWrongWord(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.learning.masterWrongWord(userId, id);
  }

  /** F2 错词批量操作：批量标记已掌握 / 批量删除 */
  @Post('wrong-words/batch')
  batchWrongWords(@CurrentUser() userId: string, @Body() dto: BatchWrongWordDto) {
    return this.learning.batchWrongWords(userId, dto.ids, dto.action);
  }

  /** A2 错词本 SRS：到期待复习队列 + 学习中/逾期/已掌握统计 */
  @Get('wrong-words/due')
  dueWrongWords(@CurrentUser() userId: string) {
    return this.learning.dueWrongWords(userId);
  }

  /** A2 错词本 SRS：复习反馈（记住了 / 再练一次） */
  @Post('wrong-words/:id/review')
  reviewWrongWord(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: ReviewWrongWordDto) {
    return this.learning.reviewWrongWord(userId, id, dto.remembered);
  }

  /** I1 近 N 天复习趋势（默认 7 天） */
  @Get('review-stats')
  reviewStats(@CurrentUser() userId: string, @Query('days') days?: string) {
    return this.learning.reviewStats(userId, Number(days));
  }

  /** P1「没听懂」：标记句子进入复习队列（幂等，可重复标记） */
  @Post('confused')
  markConfused(@CurrentUser() userId: string, @Body() dto: ConfusedMarkDto) {
    return this.learning.markConfused(userId, dto.sentenceId);
  }

  /** P1「没听懂」：复习队列（未听懂的句子 + 原句/所属材料） */
  @Get('confused')
  confusedList(@CurrentUser() userId: string) {
    return this.learning.confusedList(userId);
  }

  /** P1「没听懂」：取消标记（误触撤回） */
  @Delete('confused/:sentenceId')
  unmarkConfused(@CurrentUser() userId: string, @Param('sentenceId') sentenceId: string) {
    return this.learning.unmarkConfused(userId, sentenceId);
  }

  /** P1「没听懂」：复习时标记已听懂 */
  @Post('confused/:id/resolved')
  resolveConfused(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.learning.resolveConfused(userId, id);
  }

  /** K2「没听懂」：批量标记已听懂（仅本人未解决标记，返回实际处理条数） */
  @Post('confused/batch-resolved')
  batchResolveConfused(@CurrentUser() userId: string, @Body() dto: BatchResolvedConfusedDto) {
    return this.learning.batchResolveConfused(userId, dto.ids);
  }

  /** P2-2：阶段二听写优先队列（未解决没听懂 ∩ 听写清单，排除当日已听写） */
  @Get('dictation/priority')
  dictationPriority(@CurrentUser() userId: string, @Query('packId') packId: string, @Query('date') date: string) {
    return this.learning.dictationPriority(userId, packId, date);
  }

  /** 当日听写完成情况（按句最佳正确率），供阶段二展示「已完成」状态 */
  @Get('dictation/today')
  dictationToday(@CurrentUser() userId: string, @Query('date') date: string, @Query('itemId') itemId?: string) {
    return this.learning.dictationToday(userId, date, itemId);
  }

  /** A1：弱项专项训练队列（没听懂 + 错词 + 近 14 天听写低正确率，排除今日已练） */
  @Get('weak-drill')
  weakDrill(@CurrentUser() userId: string, @Query('limit') limit?: string) {
    return this.learning.weakDrill(userId, limit ? Number(limit) : 10);
  }

  /** 录音上传：通过 StorageService 统一存储（本地 uploads/ 或 S3 兼容对象存储） */
  @Post('uploads')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB 上限
    // 默认 MemoryStorage：文件进 buffer → StorageService.putBuffer() 统一落盘/入桶
  }))
  async upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('缺少文件');
    const filename = `recordings/${randomUUID()}${extname(file.originalname || '.webm')}`;
    await this.storage.putBuffer(filename, file.buffer, file.mimetype);
    return { url: await this.storage.getDownloadUrl(filename) };
  }
}
