/**
 * L1 生活文章音频生成（Edge 神经语音 en-US-JennyNeural，48kbps MP3）。
 * 每篇文章产出：逐句切片 sNN.mp3（听写用，-15% 慢速）+ 整篇 full.mp3（≥1 小时，慢/常速 pass 交替，磨耳朵）。
 * 产出 manifest.json 供 seed-l1-daily.mjs 入库。可重跑（已有文件跳过）。
 * 运行：node scripts/gen-l1-daily-audio.mjs
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import mp3Duration from 'mp3-duration';
import { ARTICLES } from './l1-daily-articles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'uploads', 'l1-daily');
const VOICE = 'en-US-JennyNeural';
const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const TARGET_SEC = 3600; // 每篇整篇音频目标 ≥1 小时
const LANES = 4;

const durOf = (buf) => new Promise((res, rej) => mp3Duration(buf, (e, d) => (e ? rej(e) : res(d))));

/** 单次合成（带重试）；每 lane 独立连接，避免并发互扰 */
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
  for (const art of ARTICLES) {
    const dir = join(ROOT, art.slug);
    mkdirSync(dir, { recursive: true });
    console.log(`\n== ${art.title} (${art.sentences.length} 句) -> ${dir}`);

    // 1) 逐句切片（4 lane 并发，限速 -15% 保证听写清晰）
    const sentenceFiles = [];
    const tasks = art.sentences.map((s, i) => ({ ...s, seq: i + 1, file: `s${String(i + 1).padStart(2, '0')}.mp3` }));
    let done = 0;
    const laneWork = async (lane) => {
      for (const t of tasks.filter((_, idx) => idx % LANES === lane)) {
        const path = join(dir, t.file);
        if (!existsSync(path) || statSync(path).size < 1000) {
          const buf = await synth(lane, t.text, '-15%');
          writeFileSync(path, buf);
        }
        done++;
        if (done % 20 === 0) console.log(`  句切片 ${done}/${tasks.length}`);
      }
    };
    await Promise.all(Array.from({ length: LANES }, (_, l) => laneWork(l)));

    // 2) 整篇 pass：慢速(-15%) + 常速(-5%) 各一条；超长文本失败时按 12 句分块合成再拼接
    const fullText = art.sentences.map((s) => s.text).join(' ');
    const buildPass = async (name, rate) => {
      const path = join(dir, name);
      if (existsSync(path) && statSync(path).size > 10000) return path;
      let buf;
      try {
        buf = await synth(0, fullText, rate);
      } catch {
        console.log(`  ${name}: 整篇合成失败，分块重试`);
        const parts = [];
        for (let i = 0; i < art.sentences.length; i += 12) {
          parts.push(await synth(0, art.sentences.slice(i, i + 12).map((s) => s.text).join(' '), rate));
        }
        buf = Buffer.concat(parts);
      }
      writeFileSync(path, buf);
      return path;
    };
    const slowPath = await buildPass('pass-slow.mp3', '-15%');
    const fastPath = await buildPass('pass-fast.mp3', '-5%');
    const slowBuf = await durOf(slowPath).then(async (d) => ({ sec: d, buf: null, path: slowPath }));
    const fastSec = await durOf(fastPath);
    const slowSec = slowBuf.sec;
    console.log(`  pass 时长: slow=${slowSec.toFixed(0)}s fast=${fastSec.toFixed(0)}s`);

    // 3) 交替拼接至 ≥ TARGET_SEC：慢→快→慢→快…
    const slowData = await import('fs').then((fs) => fs.readFileSync(slowPath));
    const fastData = await import('fs').then((fs) => fs.readFileSync(fastPath));
    const parts = [];
    let total = 0;
    let turn = 0;
    while (total < TARGET_SEC) {
      const pick = turn % 2 === 0 ? slowData : fastData;
      parts.push(pick);
      total += turn % 2 === 0 ? slowSec : fastSec;
      turn++;
    }
    const full = Buffer.concat(parts);
    writeFileSync(join(dir, 'full.mp3'), full);
    const fullDur = await durOf(full);
    console.log(`  full.mp3: ${(full.length / 1048576).toFixed(1)}MB, ${fullDur.toFixed(0)}s (${(fullDur / 60).toFixed(1)}min), ${turn} 个 pass`);

    // 4) manifest（供入库脚本使用）
    const manifest = {
      slug: art.slug,
      title: art.title,
      titleZh: art.titleZh,
      fullDurationSec: Math.round(fullDur),
      sentences: art.sentences.map((s, i) => ({ seq: i + 1, text: s.text, zh: s.zh, file: `s${String(i + 1).padStart(2, '0')}.mp3` })),
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`  manifest.json 写入完成`);
  }
  console.log('\n全部完成');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
