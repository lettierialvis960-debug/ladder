/**
 * P1-2 逐句高亮跟随：重建 l1-daily 整篇音频为「逐句缓冲区精确拼接」，并生成时间轴。
 *
 * 背景：原 full 音频是「整篇连续 TTS 慢/快 pass 交替拼接」，句边界无法从外部得知。
 * 本脚本改为按句拼接（慢速 = 既有 sNN.mp3，快速 = 逐句新合成 fNN.mp3），
 * 每句在整篇音频中的 startSec 由累加精确已知 → 写入 ContentItem.timelineJson
 * （格式 [{seq,startSec}] 按播放顺序），供前端随播放高亮当前句。
 *
 * 幂等可重跑：fNN.mp3 按文件缓存跳过；full-20min.mp3 与 DB 每次整体重写。
 * 运行：node scripts/rebuild-l1-full-timeline.mjs（需 DATABASE_URL，自动读 .env）
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import mp3Duration from 'mp3-duration';
import { PrismaClient } from '@prisma/client';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'uploads', 'l1-daily');
const VOICE = 'en-US-JennyNeural';
const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const TARGET_SEC = 1200; // 每篇目标 ≥20 分钟（pass 边界对齐，可略超）
const LANES = 4;
const PACK_TITLE = '生活听力精选（初阶）';

if (!process.env.DATABASE_URL) {
  const env = readFileSync(join(HERE, '..', '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
    if (m) { process.env.DATABASE_URL = m[1].trim(); break; }
  }
}
const prisma = new PrismaClient();

const durOf = (buf) => new Promise((res, rej) => mp3Duration(buf, (e, d) => (e ? rej(e) : res(d))));

/** 单次合成（带重试）；每 lane 独立连接，避免并发互扰（与 gen-l1-daily-audio.mjs 一致） */
async function synth(lane, text, rate) {
  for (let i = 0; i < 4; i++) {
    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(VOICE, FORMAT);
      const { audioStream } = await tts.toStream(text, { rate });
      const chunks = [];
      for await (const c of audioStream) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.length < 500) throw new Error(`too small: ${buf.length}`);
      return buf;
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function main() {
  const slugs = ['morning-routine', 'supermarket-trip', 'park-afternoon'];

  for (const slug of slugs) {
    const dir = join(ROOT, slug);
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    console.log(`\n== ${m.titleZh} (${m.sentences.length} 句)`);

    // 1) 慢速切片（已有 sNN.mp3）+ 快速切片（-5%，缺失才合成，fNN.mp3 缓存）
    const laneWork = async (lane, rate, prefix) => {
      for (const s of m.sentences.filter((_, idx) => idx % LANES === lane)) {
        const file = `${prefix}${String(s.seq).padStart(2, '0')}.mp3`;
        const path = join(dir, file);
        if (!existsSync(path) || statSync(path).size < 1000) {
          const buf = await synth(lane, s.text, rate);
          writeFileSync(path, buf);
        }
      }
    };
    await Promise.all(Array.from({ length: LANES }, (_, l) => laneWork(l, '-5%', 'f')));
    console.log('  快速切片就绪');

    // 2) 测量每句时长（慢/快两组）
    const slow = [];
    const fast = [];
    for (const s of m.sentences) {
      const nn = String(s.seq).padStart(2, '0');
      const sBuf = readFileSync(join(dir, `s${nn}.mp3`));
      const fBuf = readFileSync(join(dir, `f${nn}.mp3`));
      slow.push({ seq: s.seq, buf: sBuf, sec: await durOf(sBuf) });
      fast.push({ seq: s.seq, buf: fBuf, sec: await durOf(fBuf) });
    }
    const slowPassSec = slow.reduce((t, x) => t + x.sec, 0);
    const fastPassSec = fast.reduce((t, x) => t + x.sec, 0);
    console.log(`  单 pass 时长: slow=${slowPassSec.toFixed(1)}s fast=${fastPassSec.toFixed(1)}s`);

    // 3) 慢/快 pass 交替拼接至 ≥20 分钟（pass 边界收尾），累加时间轴
    const parts = [];
    const timeline = [];
    let offset = 0;
    let turn = 0;
    while (offset < TARGET_SEC) {
      const pass = turn % 2 === 0 ? slow : fast;
      for (const x of pass) {
        parts.push(x.buf);
        timeline.push({ seq: x.seq, startSec: Math.round(offset * 100) / 100 });
        offset += x.sec;
      }
      turn++;
    }
    writeFileSync(join(dir, 'full-20min.mp3'), Buffer.concat(parts));
    console.log(`  full-20min.mp3 重建: ${offset.toFixed(1)}s, ${turn} 个 pass, 时间轴 ${timeline.length} 点`);

    // 4) 更新 DB：时长 + 时间轴
    const item = await prisma.contentItem.findFirst({
      where: { pack: { title: PACK_TITLE }, audioUrl: { endsWith: `/uploads/l1-daily/${slug}/full-20min.mp3` } },
    });
    if (!item) throw new Error(`未找到 ${slug} 对应的 ContentItem`);
    await prisma.contentItem.update({
      where: { id: item.id },
      data: { durationSec: Math.round(offset), timelineJson: JSON.stringify(timeline) },
    });
    console.log(`  DB 更新: ${item.id} durationSec=${Math.round(offset)}`);
  }

  console.log('\n全部完成');
  await prisma.$disconnect();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
