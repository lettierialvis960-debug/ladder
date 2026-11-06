// 数据库崩溃恢复脚本（PGlite）。
// 原则：绝不直接删数据 —— 先完整备份，再清理 stale pid，必要时把坏目录改名隔离后重建。
//
// 用法：cd apps/api && npm run db:recover
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiDir = dirname(__dirname);
// 默认数据目录（数据落 E 盘，可用 PG_DATA_DIR 覆盖）
const DEFAULT_DATA_DIR = 'E:\\dev\\ladder\\data\\pgdata';

const dataDir =
  process.env.PG_DATA_DIR ||
  (fs.existsSync(DEFAULT_DATA_DIR) ? DEFAULT_DATA_DIR : join(apiDir, 'prisma', 'pgdata'));
const backupRoot = join(dirname(dataDir), 'pgdata-backups');
const pidFile = join(dataDir, 'postmaster.pid');
const port = Number(process.env.PG_PORT || 5432);

const ts = new Date()
  .toISOString()
  .replace(/[-:T]/g, '')
  .slice(0, 14);

function log(step, msg) {
  console.log(`[db-recover] ${step} ${msg}`);
}

function fail(msg) {
  console.error(`[db-recover] 失败：${msg}`);
  process.exit(1);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
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

// 读取 .env（不引入第三方依赖），供 prisma migrate deploy 使用
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

const envFromFile = loadEnvFile(join(apiDir, '.env'));

// 必须用异步 spawn：PGlite 与 Prisma 客户端运行在同一事件循环里，
// spawnSync 会阻塞事件循环，导致临时 TCP 桥无法响应迁移连接（P1001）。
function runPrismaMigrate(databaseUrl) {
  return new Promise((resolve) => {
    const prismaBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(prismaBin, ['prisma', 'migrate', 'deploy'], {
      cwd: apiDir,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    child.on('exit', (code) => resolve(code));
    child.on('error', (err) => {
      console.error(`[db-recover] 启动 prisma 失败：${err?.message || err}`);
      resolve(-1);
    });
  });
}

async function main() {
  log('0/4', `目标数据目录：${dataDir}`);

  // 运行中的数据库不能安全拷贝/恢复，先确认端口空闲
  if (await checkPortInUse(port)) {
    fail(
      `端口 ${port} 正在被监听，说明数据库仍在运行。恢复会拷贝不一致的数据，请先停止 pg-server 后重试。`,
    );
  }

  if (!fs.existsSync(dataDir)) {
    log('1/4', '数据目录不存在，跳过备份。');
    fs.mkdirSync(dataDir, { recursive: true });
  } else {
    // 步骤 1：完整备份（复制，不移动）
    fs.mkdirSync(backupRoot, { recursive: true });
    const backupDir = join(backupRoot, `pgdata-${ts}`);
    try {
      fs.cpSync(dataDir, backupDir, { recursive: true, force: true });
    } catch (err) {
      fail(`备份数据目录失败：${err?.message || err}`);
    }
    const bytes = fs
      .readdirSync(backupDir, { recursive: true })
      .reduce((sum, name) => {
        try {
          return sum + fs.statSync(join(backupDir, name)).size;
        } catch {
          return sum;
        }
      }, 0);
    log('1/4', `已备份到：${backupDir}（约 ${(bytes / 1024 / 1024).toFixed(1)} MB）`);
  }

  // 步骤 2：清理 stale postmaster.pid（仅当确认进程不存活）
  if (fs.existsSync(pidFile)) {
    let pid = NaN;
    try {
      pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').split('\n')[0].trim(), 10);
    } catch {
      // 文件损坏按 stale 处理
    }
    if (isPidAlive(pid)) {
      fail(`postmaster.pid 中的进程 pid=${pid} 仍存活，请先停止该进程，避免误删运行中实例的锁。`);
    }
    fs.rmSync(pidFile, { force: true });
    log('2/4', `已清理 stale postmaster.pid（pid=${pid} 不在运行）`);
  } else {
    log('2/4', '没有残留 postmaster.pid，跳过。');
  }

  // 步骤 3：尝试初始化，验证目录是否可用
  try {
    const db = new PGlite(dataDir);
    await db.waitReady;
    await db.close();
    log('3/4', '数据库初始化正常，无需重建。');
    log('4/4', `恢复流程结束：数据目录可用；备份见 ${join(backupRoot, `pgdata-${ts}`)}`);
    process.exit(0);
  } catch (err) {
    log('3/4', `数据库仍无法初始化：${err?.message || err}`);
  }

  // 步骤 4：隔离损坏目录并重建空库
  const corruptDir = `${dataDir}.corrupt-${ts}`;
  try {
    fs.renameSync(dataDir, corruptDir);
    fs.mkdirSync(dataDir, { recursive: true });
    log('4/4', `坏目录已改名隔离：${corruptDir}（未删除，可人工取证后再清理）`);
  } catch (err) {
    fail(`隔离坏目录失败：${err?.message || err}`);
  }

  // 在空目录上启动临时 TCP 桥，供 prisma migrate deploy 连接
  let db;
  let server;
  try {
    db = new PGlite(dataDir);
    await db.waitReady;
    server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 5 });
    await server.start();
    log('4/4', `临时数据库已监听 127.0.0.1:${port}，开始执行 prisma migrate deploy ...`);

    const databaseUrl =
      process.env.DATABASE_URL ||
      envFromFile.DATABASE_URL ||
      `postgresql://postgres:postgres@127.0.0.1:${port}/ladder?schema=public&pgbouncer=true`;
    const code = await runPrismaMigrate(databaseUrl);
    if (code !== 0) {
      fail(`prisma migrate deploy 执行失败（退出码 ${code}），空库保留在 ${dataDir}。`);
    }
  } catch (err) {
    fail(`重建空库时出错：${err?.message || err}`);
  } finally {
    if (server) await server.stop().catch(() => {});
    if (db) await db.close().catch(() => {});
  }

  console.log('');
  console.log('[db-recover] ================= 恢复结果 =================');
  console.log(`[db-recover] 原数据备份：${join(backupRoot, `pgdata-${ts}`)}`);
  console.log(`[db-recover] 损坏目录：${corruptDir}`);
  console.log(`[db-recover] 新数据目录：${dataDir}（已跑完迁移，当前为空库）`);
  console.log('[db-recover] 如需内置演示数据：cd apps/api && npx prisma db seed');
  console.log('[db-recover] 如需业务数据：可用备份目录中的文件或 SQLite 备份人工恢复。');
  console.log('[db-recover] 完成后运行：npm run db:start');
  process.exit(0);
}

main().catch((err) => {
  fail(`未预期的错误：${err?.message || err}`);
});
