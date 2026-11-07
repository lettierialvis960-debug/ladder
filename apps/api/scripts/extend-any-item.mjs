import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import mp3Duration from 'mp3-duration';
import { PrismaClient } from '@prisma/client';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.STORAGE_LOCAL_ROOT || 'E:\\dev\\ladder\\data\\uploads';
const VOICE = 'en-US-JennyNeural';
const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const TARGET_SEC = 1200;
const LANES = 4;

if (!process.env.DATABASE_URL) {
  const env = readFileSync(join(HERE, '..', '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
    if (m) { process.env.DATABASE_URL = m[1].trim(); break; }
  }
}
if (!process.env.STORAGE_LOCAL_ROOT) {
  const env = readFileSync(join(HERE, '..', '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*STORAGE_LOCAL_ROOT\s*=\s*"?([^"\r\n]+)"?/);
    if (m) { process.env.STORAGE_LOCAL_ROOT = m[1].trim(); break; }
  }
}

const durOf = (buf) => new Promise((res, rej) => mp3Duration(buf, (e, d) => (e ? rej(e) : res(d))));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const round2 = (x) => Math.round(x * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');

async function synth(text, rate) {
  for (let i = 0; i < 4; i++) {
    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(VOICE, FORMAT);
      const { audioStream } = await tts.toStream(text, { rate });
      const chunks = [];
      const readAll = (async () => { for await (const c of audioStream) chunks.push(c); })();
      await Promise.race([readAll, new Promise((_, rej) => setTimeout(() => rej(new Error('tts timeout')), 30000))]);
      const buf = Buffer.concat(chunks);
      if (buf.length < 500) throw new Error(`too small: ${buf.length}`);
      return buf;
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function buildArticle(itemId, prisma) {
  const item = await prisma.contentItem.findUnique({ where: { id: itemId }, include: { sentences: { orderBy: { seq: 'asc' } } } });
  if (!item) throw new Error('item not found: ' + itemId);
  const sentences = item.sentences;
  const n = sentences.length;
  // dir 从 audioUrl 反解：/uploads/custom/<dir>/full.mp3
  const m = item.audioUrl?.match(/custom\/([^/]+)\//);
  if (!m) throw new Error('cannot parse dir from audioUrl: ' + item.audioUrl);
  const dir = join(ROOT, 'custom', m[1]);
  mkdirSync(dir, { recursive: true });
  const urlPath = (file) => `/uploads/custom/${m[1]}/${file}`;

  console.log(`\n=== ${item.title} (${n} 句) ===`);

  // 1) 逐句 slow(-15%) + fast(-5%)
  const tasks = [];
  for (let i = 0; i < n; i++) {
    tasks.push({ text: sentences[i].text, file: `s${pad(i + 1)}.mp3`, rate: '-15%' });
    tasks.push({ text: sentences[i].text, file: `f${pad(i + 1)}.mp3`, rate: '-5%' });
  }
  let done = 0;
  const laneWork = async (lane) => {
    for (const t of tasks.filter((_, idx) => idx % LANES === lane)) {
      const path = join(dir, t.file);
      if (!existsSync(path) || statSync(path).size < 1000) {
        const buf = await synth(t.text, t.rate);
        writeFileSync(path, buf);
      }
      done++;
      if (done % 20 === 0) console.log(`  切片 ${done}/${tasks.length}`);
    }
  };
  await Promise.all(Array.from({ length: LANES }, (_, l) => laneWork(l)));

  // 2) 测量时长
  const slowSec = [], fastSec = [];
  for (let i = 1; i <= n; i++) {
    slowSec.push(await durOf(readFileSync(join(dir, `s${pad(i)}.mp3`))));
    fastSec.push(await durOf(readFileSync(join(dir, `f${pad(i)}.mp3`))));
  }
  console.log(`  单 pass: slow=${sum(slowSec).toFixed(1)}s fast=${sum(fastSec).toFixed(1)}s`);

  // 3) pass 拼接
  const slowBuf = Buffer.concat(sentences.map((_, i) => readFileSync(join(dir, `s${pad(i + 1)}.mp3`))));
  const fastBuf = Buffer.concat(sentences.map((_, i) => readFileSync(join(dir, `f${pad(i + 1)}.mp3`))));

  // 4) full.mp3：慢/快交替至 ≥1200s
  const parts = [];
  const timeline = [];
  let offset = 0;
  let turn = 0;
  while (offset < TARGET_SEC) {
    const isSlow = turn % 2 === 0;
    const secs = isSlow ? slowSec : fastSec;
    parts.push(isSlow ? slowBuf : fastBuf);
    for (let i = 0; i < n; i++) {
      timeline.push({ seq: i + 1, startSec: round2(offset), endSec: round2(offset + secs[i]), pass: turn + 1, passType: isSlow ? 'slow' : 'fast' });
      offset += secs[i];
    }
    turn++;
  }
  const full = Buffer.concat(parts);
  writeFileSync(join(dir, 'full.mp3'), full);
  const fullSec = Math.round(await durOf(full));
  console.log(`  full.mp3: ${(full.length / 1048576).toFixed(1)}MB, ${fullSec}s（${(fullSec / 60).toFixed(1)}min），${turn} passes，时间轴 ${timeline.length} 点`);

  // 5) 入库：保留原句 id，只更新 audioUrl/时长/时间轴
  await prisma.contentItem.update({
    where: { id: itemId },
    data: { audioUrl: urlPath('full.mp3'), durationSec: fullSec, timelineJson: JSON.stringify(timeline) },
  });
  await prisma.$transaction(
    sentences.map((s, i) =>
      prisma.sentence.update({
        where: { id: s.id },
        data: { audioUrl: urlPath(`s${pad(i + 1)}.mp3`) },
      }),
    ),
  );
  console.log(`  DB 更新完成: durationSec=${fullSec}`);
  return { title: item.title, itemId, n, fullSec };
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (ids.length === 0) { console.log('用法: node extend-any-item.mjs <itemId1> [itemId2 ...]'); process.exit(1); }
  const prisma = new PrismaClient();
  const results = [];
  try {
    for (const id of ids) results.push(await buildArticle(id, prisma));
    console.log('\n=== 汇总 ===');
    for (const r of results) console.log(`${r.title}: ${r.n} 句, ${r.fullSec}s (${(r.fullSec / 60).toFixed(1)}min)`);
    console.log(`合计 ${sum(results.map((r) => r.fullSec))}s (${(sum(results.map((r) => r.fullSec)) / 60).toFixed(1)}min)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
