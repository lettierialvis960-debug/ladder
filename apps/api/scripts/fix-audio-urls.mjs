/**
 * 一次性维护脚本：把既有种子数据的占位音频扩展名从 .mp3 改为实际生成的 .wav。
 * 仅更新 URL 字符串，不触碰其它字段（非破坏性）。
 * 运行：node scripts/fix-audio-urls.mjs（需 DATABASE_URL）
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const items = await prisma.$executeRawUnsafe(
  `UPDATE "ContentItem" SET "audioUrl" = REPLACE("audioUrl", '.mp3', '.wav')`,
);
const sentences = await prisma.$executeRawUnsafe(
  `UPDATE "Sentence" SET "audioUrl" = REPLACE("audioUrl", '.mp3', '.wav')`,
);
console.log(`updated: ContentItem=${items}, Sentence=${sentences}`);
await prisma.$disconnect();
