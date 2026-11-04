/**
 * 历史文件迁移：本地 uploads/ → S3 兼容对象存储（幂等、可预演、可校验）
 *
 * 用法（在 apps/api 目录下）：
 *   node scripts/migrate-uploads-to-s3.mjs --dry-run           # 只打印计划，不动手
 *   node scripts/migrate-uploads-to-s3.mjs                     # 执行迁移（已存在的跳过）
 *   node scripts/migrate-uploads-to-s3.mjs --force             # 覆盖已存在的对象
 *   node scripts/migrate-uploads-to-s3.mjs --delete-local      # 校验通过后删除本地文件
 *   node scripts/migrate-uploads-to-s3.mjs --concurrency=8     # 并发度（默认 8）
 *
 * key 映射：本地相对路径原样保留（含历史嵌套 uploads/uploads/xxx 结构），
 * 因此旧库里的 /uploads/{rel} URL 通过 parseKeyFromUrl 可直接反查并签发。
 */
import { existsSync } from 'fs';
import { resolve, relative, dirname, sep, extname } from 'path';
import { readdir, stat, readFile, unlink } from 'fs/promises';
import { fileURLToPath } from 'url';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

// ---- 载入 .env（与 API 共用同一份配置）----
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '..', '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const DELETE_LOCAL = args.includes('--delete-local');
const CONCURRENCY = Math.max(
  1,
  Number(args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? 8),
);

const ROOT = process.env.STORAGE_LOCAL_ROOT
  ? resolve(process.env.STORAGE_LOCAL_ROOT)
  : resolve(here, '..', 'uploads');
const BUCKET = process.env.S3_BUCKET;
const PREFIX = (process.env.S3_KEY_PREFIX ?? 'uploads/').replace(/^\/+/, '').replace(/\/?$/, '/');

const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(ROOT)) fail(`本地目录不存在: ${ROOT}`);
if (!BUCKET) fail('缺少 S3_BUCKET（检查 apps/api/.env）');
if (!process.env.S3_ENDPOINT && !process.env.S3_REGION) fail('缺少 S3_ENDPOINT / S3_REGION');

const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'x',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'x',
  },
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'false').toLowerCase() === 'true',
});

console.log(`源目录 : ${ROOT}`);
console.log(`目标桶 : ${BUCKET} (前缀 ${PREFIX})`);
console.log(`模式   : ${DRY_RUN ? 'DRY-RUN' : FORCE ? '覆盖' : '增量（跳过已存在）'}\n`);

/** 递归收集本地文件 → { key, abs, size } */
async function collect(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(abs, acc);
    } else if (entry.isFile()) {
      const rel = relative(ROOT, abs).split(sep).join('/');
      acc.push({ key: rel, abs, size: (await stat(abs)).size });
    }
  }
  return acc;
}

async function existsInBucket(objectKey) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: objectKey }));
    return true;
  } catch (e) {
    if (e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound') return false;
    throw e;
  }
}

async function uploadOne(file) {
  const objectKey = PREFIX + file.key;
  if (!FORCE && (await existsInBucket(objectKey))) return 'skip';

  if (DRY_RUN) return 'planned';

  const body = await readFile(file.abs);
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: objectKey,
    Body: body,
    ContentType: CONTENT_TYPES[extname(file.key).toLowerCase()] ?? 'application/octet-stream',
  }));
  return 'uploaded';
}

async function pool(items, limit, worker) {
  const stats = { uploaded: 0, skip: 0, planned: 0, failed: 0, bytes: 0 };
  const failures = [];
  let index = 0;

  async function run() {
    while (index < items.length) {
      const current = items[index++];
      try {
        const r = await worker(current);
        if (r === 'uploaded') { stats.uploaded++; stats.bytes += current.size; }
        else stats[r]++;
      } catch (e) {
        stats.failed++;
        failures.push({ key: current.key, error: e.message });
      }
      const done = stats.uploaded + stats.skip + stats.planned + stats.failed;
      if (done % 50 === 0 || done === items.length) {
        process.stdout.write(`\r进度 ${done}/${items.length}  (上传 ${stats.uploaded} / 跳过 ${stats.skip})`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return { stats, failures };
}

const startedAt = Date.now();
const files = await collect(ROOT);
console.log(`扫描到 ${files.length} 个文件，${(files.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB`);

const { stats, failures } = await pool(files, CONCURRENCY, uploadOne);
process.stdout.write('\n\n');

console.log(`上传 ${stats.uploaded} 个（${(stats.bytes / 1024 / 1024).toFixed(1)} MB）`);
console.log(`跳过 ${stats.skip} 个（桶内已存在）`);
if (DRY_RUN) console.log(`待上传 ${stats.planned} 个`);
if (stats.failed) {
  console.log(`失败 ${stats.failed} 个：`);
  failures.slice(0, 10).forEach((f) => console.log(`  - ${f.key}: ${f.error}`));
}

// ---- 桶内对象数校验 ----
const listed = [];
let token;
do {
  const page = await client.send(new ListObjectsV2Command({
    Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token, MaxKeys: 1000,
  }));
  (page.Contents ?? []).forEach((o) => listed.push(o));
  token = page.NextContinuationToken;
} while (token);

const localKeys = new Set(files.map((f) => PREFIX + f.key));
const bucketKeys = new Set(listed.map((o) => o.Key));
const missing = [...localKeys].filter((k) => !bucketKeys.has(k));

console.log(`\n桶内 ${PREFIX} 下共 ${listed.length} 个对象`);
if (DRY_RUN) {
  console.log(`（DRY-RUN：实际未上传，缺失 ${missing.length} 个属预期）`);
} else if (missing.length) {
  console.log(`✗ 仍缺失 ${missing.length} 个，示例：${missing.slice(0, 5).join(', ')}`);
} else {
  console.log('✓ 本地所有文件均已存在于桶内');
}

if (!DRY_RUN && (stats.failed || missing.length)) fail('迁移未完全成功，未删除任何本地文件');

// ---- 可选：删除本地（仅在全部校验通过后）----
if (DELETE_LOCAL && !DRY_RUN) {
  let deleted = 0;
  for (const f of files) {
    await unlink(f.abs);
    deleted++;
  }
  console.log(`已删除本地文件 ${deleted} 个`);
} else if (DELETE_LOCAL && DRY_RUN) {
  console.log('（DRY-RUN 不删除本地文件）');
}

console.log(`\n完成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
