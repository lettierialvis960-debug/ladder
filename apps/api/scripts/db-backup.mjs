// 数据库备份脚本（PGlite）。
// 仅限于「数据一致性」目的：数据库运行中直接拷贝可能拿到不一致快照，
// 因此运行中会先通过 Prisma 执行 CHECKPOINT 再拷贝，并在输出中注明风险。
//
// 用法：cd apps/api && npm run db:backup
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiDir = dirname(__dirname);
// 默认数据目录（数据落 E 盘，可用 PG_DATA_DIR 覆盖）
const DEFAULT_DATA_DIR = 'E:\\dev\\ladder\\data\\pgdata';

const dataDir =
  process.env.PG_DATA_DIR ||
  (fs.existsSync(DEFAULT_DATA_DIR) ? DEFAULT_DATA_DIR : join(apiDir, 'prisma', 'pgdata'));
const backupRoot = join(dirname(dataDir), 'pgdata-backups');
const port = Number(process.env.PG_PORT || 5432);
const KEEP = 3;

const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function loadEnvFile(file) {
  const map = {};
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m || m[1].startsWith('#')) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map[m[1]] = value;
  }
  return map;
}

function checkPortInUse(portToCheck) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: portToCheck });
    const finish = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

// 运行中备份前先 checkpoint，尽量把 WAL 中的变更刷入数据文件
async function checkpointIfRunning() {
  if (!(await checkPortInUse(port))) {
    console.log('[db-backup] 数据库未运行：执行干净备份。');
    return;
  }
  console.log('[db-backup] 数据库正在运行，先执行 CHECKPOINT 再拷贝；仍建议日后在停机状态下做备份。');
  const envFromFile = loadEnvFile(join(apiDir, '.env'));
  const databaseUrl =
    process.env.DATABASE_URL ||
    envFromFile.DATABASE_URL ||
    `postgresql://postgres:postgres@127.0.0.1:${port}/ladder?schema=public&pgbouncer=true`;
  process.env.DATABASE_URL = databaseUrl;
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe('CHECKPOINT');
    console.log('[db-backup] CHECKPOINT 完成。');
  } finally {
    await prisma.$disconnect();
  }
}

function main() {
  if (!fs.existsSync(dataDir)) {
    console.error(`[db-backup] 数据目录不存在：${dataDir}`);
    process.exit(1);
  }

  fs.mkdirSync(backupRoot, { recursive: true });
  const backupDir = join(backupRoot, `pgdata-${ts}`);
  fs.cpSync(dataDir, backupDir, { recursive: true, force: true });

  const bytes = fs
    .readdirSync(backupDir, { recursive: true })
    .reduce((sum, name) => {
      try {
        return sum + fs.statSync(join(backupDir, name)).size;
      } catch {
        return sum;
      }
    }, 0);
  console.log(`[db-backup] 已备份到：${backupDir}（约 ${(bytes / 1024 / 1024).toFixed(1)} MB）`);

  // 只保留最近 3 份自动备份（手动备份 pgdata-before-test-* 不参与清理）
  const autoBackups = fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^pgdata-\d{14}$/.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const name of autoBackups.slice(KEEP)) {
    fs.rmSync(join(backupRoot, name), { recursive: true, force: true });
    console.log(`[db-backup] 已清理旧备份：${name}`);
  }
  console.log(`[db-backup] 保留最近 ${KEEP} 份自动备份于：${backupRoot}`);
}

checkpointIfRunning()
  .then(main)
  .catch((err) => {
    console.error(`[db-backup] 备份失败：${err?.message || err}`);
    process.exit(1);
  });
