import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ContentService } from './content.service';

class CustomImportDto {
  @IsOptional() @IsString() @MaxLength(60) title?: string;
  @IsString() @MinLength(20) @MaxLength(8000) text: string;
  @IsOptional() @IsString() @MaxLength(8000) translation?: string;
}

/**
 * FR-02 内容库。官方内容公开可读（SR-05：未登录可浏览样本）；
 * B1 自定义材料为个人数据，需登录且仅本人可见。
 */
@Controller()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  /** GET /api/levels —— L1/L2/L3 分级列表（FR-01 分级引导） */
  @Get('levels')
  levels() {
    return this.content.levels();
  }

  /** GET /api/content/packs?level=L1 —— 某级别下全部官方内容包 */
  @Get('content/packs')
  packs(@Query('level') level: string) {
    return this.content.packs(level);
  }

  /** GET /api/content/items?packId=&list=listening|dictation —— 包内材料（按清单过滤） */
  @Get('content/items')
  items(@Query('packId') packId: string, @Query('list') list?: 'listening' | 'dictation') {
    return this.content.items(packId, list);
  }

  /** GET /api/content/items/:id/sentences —— 材料句切片（听写/跟读最小单元） */
  @Get('content/items/:id/sentences')
  sentences(@Param('id') itemId: string) {
    return this.content.sentences(itemId);
  }

  /** I2 GET /api/content/search?q=&packId=&list= —— 搜索材料标题与句子（含本人自定义材料） */
  @UseGuards(JwtAuthGuard)
  @Get('content/search')
  search(
    @CurrentUser() userId: string,
    @Query('q') q: string,
    @Query('packId') packId?: string,
    @Query('list') list?: 'listening' | 'dictation',
  ) {
    return this.content.search(userId, q ?? '', list, packId);
  }

  /** F1 GET /api/content/word-audio?word= —— 单词发音（TTS 合成并缓存） */
  @UseGuards(JwtAuthGuard)
  @Get('content/word-audio')
  wordAudio(@Query('word') word: string) {
    return this.content.wordAudio(word ?? '');
  }

  /** F1 GET /api/content/word-info?word= —— 单词音标（词典查询 + 本地缓存） */
  @UseGuards(JwtAuthGuard)
  @Get('content/word-info')
  wordInfo(@Query('word') word: string) {
    return this.content.wordInfo(word ?? '');
  }

  /** E1 GET /api/content/progress?packId= —— 包内每篇材料的听/写/说覆盖进度 */
  @UseGuards(JwtAuthGuard)
  @Get('content/progress')
  progress(@CurrentUser() userId: string, @Query('packId') packId: string) {
    return this.content.progress(userId, packId);
  }

  /** B1 GET /api/content/my-items?list= —— 我的自定义材料（听力/听写清单） */
  @UseGuards(JwtAuthGuard)
  @Get('content/my-items')
  myItems(@CurrentUser() userId: string, @Query('list') list?: 'listening' | 'dictation') {
    return this.content.myItems(userId, list);
  }

  /** B1 POST /api/content/custom-import —— 粘贴文本，服务端 TTS 生成句切片 + 整篇音频 */
  @UseGuards(JwtAuthGuard)
  @Post('content/custom-import')
  importCustom(@CurrentUser() userId: string, @Body() dto: CustomImportDto) {
    return this.content.importCustom(userId, dto);
  }

  /** B1 DELETE /api/content/custom-items/:id —— 删除我的材料（连带本人学习记录与音频文件） */
  @UseGuards(JwtAuthGuard)
  @Delete('content/custom-items/:id')
  deleteCustom(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.content.deleteCustom(userId, id);
  }
}
