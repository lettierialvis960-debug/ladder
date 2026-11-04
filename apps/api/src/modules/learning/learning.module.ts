import { Module } from '@nestjs/common';
import { LearningController } from './learning.controller';
import { LearningService } from './learning.service';
import { SpeechScoringService } from './speech-scoring.service';

@Module({
  controllers: [LearningController],
  providers: [LearningService, SpeechScoringService],
})
export class LearningModule {}
