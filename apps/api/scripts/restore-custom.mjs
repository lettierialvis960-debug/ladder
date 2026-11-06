/**
 * 恢复 uploads/custom 下两篇自定义材料入库。
 *
 * 背景：库迁移后这两篇的文稿记录丢失，只剩音频（full.mp3 + s01..s05.mp3）。
 * 文稿由本地 faster-whisper 转写后写入 scripts/custom-texts.json，本脚本据此重建 items。
 *
 * 运行：node scripts/restore-custom.mjs --owner=<email>
 * 文本：scripts/custom-texts.json 形如
 *   { "<dirUuid>": { "title": "...", "sentences": ["EN1", "EN2", ...], "translations": ["ZH1", ...] } }
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'uploads', 'custom');
const TEXTS = join(HERE, 'custom-texts.json');

if (!process.env.DATABASE_URL) {
  const env = readFileSync(join(HERE, '..', '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
    if (m) { process.env.DATABASE_URL = m[1].trim(); break; }
  }
}

const ownerArg = process.argv.find((a) => a.startsWith('--owner='))?.split('=')[1] ?? 'audit-offline@ladder.local';
const prisma = new PrismaClient();

const durOf = async (buf) => {
  const { default: mp3Duration } = await import('mp3-duration');
  return new Promise((res, rej) => mp3Duration(buf, (e, d) => (e ? rej(e) : res(d))));
};

async function main() {
  const user = await prisma.user.findFirst({ where: { email: ownerArg } });
  if (!user) throw new Error(`找不到账号 ${ownerArg}`);

  const texts = JSON.parse(readFileSync(TEXTS, 'utf8'));
  const dirs = Object.keys(texts);

  let pack = await prisma.contentPack.findFirst({ where: { ownerId: user.id } });
  if (!pack) {
    pack = await prisma.contentPack.create({
      data: { ownerId: user.id, levelCode: 'L1', title: '我的材料', tags: 'CUSTOM' },
    });
    console.log('创建「我的材料」包');
  }

  for (const dirUuid of dirs) {
    const t = texts[dirUuid];
    const dir = join(ROOT, dirUuid);
    if (!existsSync(dir)) { console.log('跳过（目录不存在）:', dirUuid); continue; }

    const sentenceCount = t.sentences.length;
    const fullPath = join(dir, 'full.mp3');
    const fullSec = Math.round(await durOf(readFileSync(fullPath)));

    // 幂等：按音频路径去重（同标题不同版本不会被误删）
    const audioUrl = `/uploads/custom/${dirUuid}/full.mp3`;
    const old = await prisma.contentItem.findFirst({
      where: { packId: pack.id, audioUrl },
      select: { id: true },
    });
    if (old) {
      const count = await prisma.sentence.count({ where: { itemId: old.id } });
      if (count > 0) {
        console.log('已存在，跳过:', t.title);
        continue;
      }
      // 句子丢失（如误删）时补齐句子，不动已有学习记录
      await prisma.sentence.createMany({
        data: t.sentences.map((text, i) => ({
          itemId: old.id,
          seq: i + 1,
          text,
          translation: (t.translations ?? [])[i] ?? '',
          audioUrl: `/uploads/custom/${dirUuid}/s${String(i + 1).padStart(2, '0')}.mp3`,
        })),
      });
      console.log(`补齐句子: ${t.title}（${t.sentences.length} 句）`);
      continue;
    }

    await prisma.contentItem.create({
      data: {
        packId: pack.id,
        title: t.title,
        audioUrl: `/uploads/custom/${dirUuid}/full.mp3`,
        durationSec: fullSec,
        transcript: t.sentences.join(' '),
        translation: (t.translations ?? []).join('\n'),
        sentences: {
          create: t.sentences.map((text, i) => ({
            seq: i + 1,
            text,
            translation: (t.translations ?? [])[i] ?? '',
            audioUrl: `/uploads/custom/${dirUuid}/s${String(i + 1).padStart(2, '0')}.mp3`,
          })),
        },
      },
    });
    console.log(`恢复: ${t.title} ${fullSec}s（${sentenceCount} 句）`);
  }

  const total = await prisma.contentItem.count({ where: { packId: pack.id } });
  console.log(`「我的材料」现有 ${total} 篇（owner=${ownerArg}）`);
}

main()
  .catch((e) => { console.error('FAILED:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
