import { Module } from '@nestjs/common';
import { DialogueController } from './dialogue.controller';
import { DialogueService } from './dialogue.service';

@Module({
  controllers: [DialogueController],
  providers: [DialogueService],
})
export class DialogueModule {}