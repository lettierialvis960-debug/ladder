import { Module } from '@nestjs/common';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { TtsService } from './tts.service';

@Module({
  controllers: [ContentController],
  providers: [ContentService, TtsService],
})
export class ContentModule {}
