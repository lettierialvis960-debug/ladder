/**
 * L1 生活听力内容入库：读取 uploads/l1-daily/<slug>/manifest.json，
 * 创建/更新 L1 的「生活听力精选」包 + 3 篇 ContentItem + 全部 Sentence。
 * 幂等：按包标题查找，已存在则清空其 items 后重建（新包尚无计划引用，安全）。
 * 运行：node scripts/seed-l1-daily.mjs（需 DATABASE_URL）
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'uploads', 'l1-daily');
const PACK_TITLE = '生活听力精选（初阶）';

const prisma = new PrismaClient();
const slugs = ['morning-routine', 'supermarket-trip', 'park-afternoon'];

const pack = await prisma.contentPack.upsert({
  where: { id: (await prisma.contentPack.findFirst({ where: { levelCode: 'L1', title: PACK_TITLE } }))?.id ?? '__none__' },
  update: {},
  create: { levelCode: 'L1', title: PACK_TITLE, tags: 'DAILY_LIFE' },
});
await prisma.contentItem.deleteMany({ where: { packId: pack.id } });

for (const slug of slugs) {
  const m = JSON.parse(readFileSync(join(ROOT, slug, 'manifest.json'), 'utf8'));
  const item = await prisma.contentItem.create({
    data: {
      packId: pack.id,
      title: m.titleZh,
      audioUrl: `/uploads/l1-daily/${slug}/full.mp3`,
      durationSec: m.fullDurationSec,
      transcript: m.sentences.map((s) => s.text).join(' '),
      translation: m.sentences.map((s) => s.zh).join('\n'),
      sentences: {
        create: m.sentences.map((s) => ({
          seq: s.seq,
          text: s.text,
          translation: s.zh,
          audioUrl: `/uploads/l1-daily/${slug}/${s.file}`,
        })),
      },
    },
  });
  console.log(`item created: ${item.title} ${item.durationSec}s (${m.sentences.length} 句)`);
}
const total = await prisma.contentItem.count({ where: { pack: { title: PACK_TITLE } } });
console.log(`包「${PACK_TITLE}」共 ${total} 篇`);
await prisma.$disconnect();
