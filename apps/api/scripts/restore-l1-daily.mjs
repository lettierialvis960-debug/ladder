/**
 * 恢复 L1「生活听力精选（初阶）」三篇文章入库（含 20 分钟版音频 + 逐句时间轴）。
 *
 * 背景：库迁移后该包丢失，但 uploads/l1-daily 下的音频与 manifest 仍在。
 * 本脚本不调用 TTS，直接复用已有 sNN.mp3（慢）与 fNN.mp3（快）切片测量时长，
 * 按与 rebuild-l1-full-timeline.mjs 相同的 slow/fast 交替规则重建时间轴。
 *
 * 幂等：先清空该包下 items 再重建。
 * 运行：node scripts/restore-l1-daily.mjs（自动读 .env 的 DATABASE_URL）
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import mp3Duration from 'mp3-duration';
import { PrismaClient } from '@prisma/client';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'uploads', 'l1-daily');
const PACK_TITLE = '生活听力精选（初阶）';
const SLUGS = ['morning-routine', 'supermarket-trip', 'park-afternoon'];
const TARGET_SEC = 1200;

if (!process.env.DATABASE_URL) {
  const env = readFileSync(join(HERE, '..', '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
    if (m) { process.env.DATABASE_URL = m[1].trim(); break; }
  }
}

const prisma = new PrismaClient();
const durOf = (buf) => new Promise((res, rej) => mp3Duration(buf, (e, d) => (e ? rej(e) : res(d))));

async function main() {
  const l1 = await prisma.level.findUnique({ where: { code: 'L1' } });
  if (!l1) throw new Error('缺少 Level L1，请先执行 prisma db seed');

  // 复用已有包；不存在则创建（官方包 ownerId = null）
  let pack = await prisma.contentPack.findFirst({ where: { levelCode: 'L1', title: PACK_TITLE } });
  if (!pack) {
    pack = await prisma.contentPack.create({
      data: { levelCode: 'L1', title: PACK_TITLE, tags: 'DAILY_LIFE' },
    });
    console.log('创建包:', PACK_TITLE);
  }
  await prisma.contentItem.deleteMany({ where: { packId: pack.id } });

  for (const slug of SLUGS) {
    const dir = join(ROOT, slug);
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const fullPath = join(dir, 'full-20min.mp3');
    const fullSec = Math.round(await durOf(readFileSync(fullPath)));

    // 与 rebuild 脚本一致：慢/快 pass 交替拼接到 ≥20 分钟，累加时间轴
    const slices = m.sentences.map((s) => {
      const nn = String(s.seq).padStart(2, '0');
      const sPath = join(dir, `s${nn}.mp3`);
      const fPath = join(dir, `f${nn}.mp3`);
      return {
        seq: s.seq,
        text: s.text,
        zh: s.zh,
        slow: existsSync(sPath) && statSync(sPath).size > 1000 ? readFileSync(sPath) : null,
        fast: existsSync(fPath) && statSync(fPath).size > 1000 ? readFileSync(fPath) : null,
      };
    });

    let timeline = null;
    if (slices.every((s) => s.slow && s.fast)) {
      const slowSec = [];
      const fastSec = [];
      for (const s of slices) {
        slowSec.push(await durOf(s.slow));
        fastSec.push(await durOf(s.fast));
      }
      const tl = [];
      let offset = 0;
      let turn = 0;
      while (offset < TARGET_SEC) {
        const lane = turn % 2 === 0 ? slowSec : fastSec;
        for (let i = 0; i < slices.length; i++) {
          tl.push({ seq: slices[i].seq, startSec: Math.round(offset * 100) / 100 });
          offset += lane[i];
        }
        turn++;
      }
      timeline = JSON.stringify(tl);
    }

    const item = await prisma.contentItem.create({
      data: {
        packId: pack.id,
        title: m.titleZh,
        audioUrl: `/uploads/l1-daily/${slug}/full-20min.mp3`,
        durationSec: fullSec,
        transcript: m.sentences.map((s) => s.text).join(' '),
        translation: m.sentences.map((s) => s.zh).join('\n'),
        timelineJson: timeline,
        sentences: {
          create: slices.map((s) => ({
            seq: s.seq,
            text: s.text,
            translation: s.zh,
            audioUrl: `/uploads/l1-daily/${slug}/s${String(s.seq).padStart(2, '0')}.mp3`,
          })),
        },
      },
    });
    console.log(
      `恢复: ${item.title} ${fullSec}s（${slices.length} 句，时间轴${timeline ? '有' : '无'}）`,
    );
  }

  const total = await prisma.contentItem.count({ where: { packId: pack.id } });
  console.log(`包「${PACK_TITLE}」现有 ${total} 篇`);
}

main()
  .catch((e) => { console.error('FAILED:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
