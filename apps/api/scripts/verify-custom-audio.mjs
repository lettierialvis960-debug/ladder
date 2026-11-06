/** 校验三篇扩充后的数据：句数/时长/时间轴/文件一致性。 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import mp3Duration from 'mp3-duration';
import { PrismaClient } from '@prisma/client';

const HERE = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const env = readFileSync(join(HERE, '..', '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
    if (m) { process.env.DATABASE_URL = m[1].trim(); break; }
  }
}
const ROOT = process.env.STORAGE_LOCAL_ROOT || 'E:\\dev\\ladder\\data\\uploads';
const prisma = new PrismaClient();
const durOf = (buf) => new Promise((res, rej) => mp3Duration(buf, (e, d) => (e ? rej(e) : res(d))));
const titles = ['校园生活 · Campus Life', '日常生活 · Daily Life', '时政新闻 · City News'];

async function main() {
  let total = 0;
  let bad = 0;
  for (const title of titles) {
    const item = await prisma.contentItem.findFirst({
      where: { title },
      include: { sentences: { orderBy: { seq: 'asc' } } },
    });
    if (!item) { console.log(`FAIL ${title}: 库中不存在`); bad++; continue; }
    const dir = join(ROOT, 'custom', item.audioUrl.split('/custom/')[1].split('/')[0]);
    const fullBuf = readFileSync(join(dir, 'full.mp3'));
    const measured = await durOf(fullBuf);
    const tl = JSON.parse(item.timelineJson || '[]');

    // 时间轴检查
    let tlBad = 0;
    const passes = new Map();
    for (const p of tl) {
      if (!(p.startSec < p.endSec)) tlBad++;
      if (p.endSec > item.durationSec + 2) tlBad++;
      if (!passes.has(p.pass)) passes.set(p.pass, { type: p.passType, seqs: [], start: p.startSec, end: 0 });
      const g = passes.get(p.pass);
      g.seqs.push(p.seq);
      g.end = Math.max(g.end, p.endSec);
    }
    // 同一 pass 内 seq 必须严格递增 1..N；相邻 pass 连续且类型交替
    for (const [no, g] of passes) {
      for (let i = 0; i < g.seqs.length; i++) if (g.seqs[i] !== i + 1) tlBad++;
      if (no > 1) {
        const prev = passes.get(no - 1);
        if (Math.abs(g.start - prev.end) > 0.5) tlBad++;
        if (g.type === prev.type) tlBad++;
      }
    }
    // 句子行与切片文件
    let fileBad = 0;
    for (const s of item.sentences) {
      const nn = String(s.seq).padStart(2, '0');
      if (!existsSync(join(dir, `s${nn}.mp3`))) fileBad++;
      if (!s.audioUrl.endsWith(`/s${nn}.mp3`)) fileBad++;
    }
    console.log(`\n== ${title}`);
    console.log(`  item=${item.id} 句数=${item.sentences.length} durationSec=${item.durationSec} 实测=${measured.toFixed(1)}s diff=${Math.abs(measured - item.durationSec).toFixed(1)}s`);
    console.log(`  timeline 点数=${tl.length} pass 数=${passes.size} 类型=${[...passes.values()].map((g) => g.type).join('>')}`);
    console.log(`  时间轴异常=${tlBad} 句/文件异常=${fileBad}`);
    // 抽查 3 句（首、中、尾）
    const sampleSeqs = [1, Math.ceil(item.sentences.length / 2), item.sentences.length];
    for (const seq of sampleSeqs) {
      const hits = tl.filter((p) => p.seq === seq);
      const p = hits[Math.floor(hits.length / 2)];
      console.log(`  抽 seq=${seq}: pass=${p.pass}(${p.passType}) ${p.startSec}s→${p.endSec}s 出现 ${hits.length} 次 ` +
        `start<end=${p.startSec < p.endSec} 在时长内=${p.endSec <= item.durationSec}`);
    }
    total += item.durationSec;
    if (Math.abs(measured - item.durationSec) >= 2 || tlBad || fileBad) bad++;
  }
  console.log(`\n三篇合计 durationSec=${total}s（${(total / 60).toFixed(1)}min），阈值 3600s，达标=${total >= 3600}`);
  console.log(bad === 0 ? 'ALL-OK' : `存在 ${bad} 篇异常`);
  await prisma.$disconnect();
  process.exitCode = bad === 0 && total >= 3600 ? 0 : 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
