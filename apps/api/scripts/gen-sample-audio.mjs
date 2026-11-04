/**
 * 生成骨架验证用示例音频（WAV）：每个内容包的整篇 + 3 个句切片。
 * 正式音频由内容运营按公开资源入库（决策 D2），此处仅保证本地可播放、可走通有效时长追踪。
 * 运行：node scripts/gen-sample-audio.mjs
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'uploads', 'sample');
const RATE = 22050; // 单声道 16-bit，足够验证播放与计时

function wavBuffer(seconds) {
  const n = Math.floor(RATE * seconds);
  const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);      // PCM
  buf.writeUInt16LE(1, 22);      // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    // 柔和提示音：220Hz 正弦 + 缓慢包络，避免刺耳
    const env = 0.25 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.25 * t));
    const s = Math.sin(2 * Math.PI * 220 * t) * env;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), 44 + i * 2);
  }
  return buf;
}

mkdirSync(OUT, { recursive: true });
const files = [['full.wav', 45], ['s1.wav', 4], ['s2.wav', 5], ['s3.wav', 3]];
for (const [name, sec] of files) {
  writeFileSync(join(OUT, name), wavBuffer(sec));
  console.log(`wrote ${name} (${sec}s) -> ${OUT}`);
}
