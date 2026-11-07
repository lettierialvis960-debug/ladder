// 嵌入式 PostgreSQL 服务器（PGlite），提供 TCP 连接供 Prisma 使用。
// 数据持久化到 pgdata，重启不丢数据；本脚本负责优雅关闭（checkpoint 落盘），
// 避免强杀/断电后出现 "database system was not properly shut down" 或初始化失败。
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 默认数据目录（数据落 E 盘，可用 PG_DATA_DIR 覆盖）
const DEFAULT_DATA_DIR = 'E:\\dev\\ladder\\data\\pgdata';

// 数据目录选择顺序：环境变量 > 已存在的 E 盘默认目录 > 仓库内 prisma/pgdata（旧路径，已废弃）
const dataDir =
  process.env.PG_DATA_DIR ||
  (fs.existsSync(DEFAULT_DATA_DIR) ? DEFAULT_DATA_DIR : join(__dirname, 'prisma', 'pgdata'));

const port = Number(process.env.PG_PORT || 5432);
const pidFile = join(dataDir, 'postmaster.pid');

let db = null;
let server = null;
let shuttingDown = false;
let checkpointTimer = null;

// 判断 pid 对应的进程是否还活着（pid<=0 是 PGlite 写入的占位值，无法判断）
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 表示进程存在但当前用户无权探测
    return err?.code === 'EPERM';
  }
}

// 检测端口是否已被监听（用于判断是否已有 pg-server 实例在跑）
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

// 清理上次异常退出残留的 postmaster.pid：只有确认对应进程已不存活才删除，避免误删运行中实例的锁
async function cleanupStalePid() {
  if (!fs.existsSync(pidFile)) return;

  let pid = NaN;
  try {
    pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').split('\n')[0].trim(), 10);
  } catch {
    // 读取失败时按 stale 处理，下方会再校验端口
  }

  if (isPidAlive(pid)) {
    console.error(`[pglite] postmaster.pid 中的进程 pid=${pid} 仍在运行，拒绝启动以免损坏数据目录。`);
    console.error('[pglite] 若确认这是残留的伪 pid，请先停止该进程或运行 npm run db:recover。');
    process.exit(1);
  }

  // PGlite 写入的 pid 通常是 -42 这类占位值，无法判断存活，用端口占用兜底
  if (pid <= 0 && (await checkPortInUse(port))) {
    console.error(`[pglite] 端口 ${port} 已被监听，说明已有数据库实例在运行，拒绝启动。`);
    process.exit(1);
  }

  try {
    fs.rmSync(pidFile, { force: true, maxRetries: 5, retryDelay: 200 });
    console.log(`[pglite] 已清理 stale postmaster.pid（pid=${pid} 已不存活）`);
  } catch (err) {
    console.error(`[pglite] 清理 postmaster.pid 失败：${err?.message || err}`);
  }
}

async function shutdown(reason) {
  if (shuttingDown) return; // 防重入：多个信号只处理一次
  shuttingDown = true;
  console.log(`[pglite] 收到 ${reason}，开始优雅关闭（checkpoint 落盘，请稍候）...`);

  // 兜底超时：10s 内没关完就强制退出，避免关不掉的进程挂住
  const forceExit = setTimeout(() => {
    console.error('[pglite] 优雅关闭超时（10s），强制退出；下次启动将依赖 PostgreSQL 恢复流程。');
    process.exit(1);
  }, 10000);

  try {
    if (checkpointTimer) clearInterval(checkpointTimer);
    if (server) {
      await server.stop();
      console.log('[pglite] TCP 服务已停止，不再接受新连接');
    }
    if (db) {
      await db.close();
      console.log('[pglite] 数据库已关闭并完成 checkpoint，数据已安全落盘');
    }
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    console.error(`[pglite] 关闭过程中发生错误：${err?.message || err}`);
    process.exit(1);
  }
}

async function main() {
  await cleanupStalePid();

  try {
    db = new PGlite(dataDir);
    await db.waitReady;
  } catch (err) {
    console.error(`[pglite] 数据库初始化失败：${err?.message || err}`);
    console.error('[pglite] 数据目录可能因异常退出而损坏，请按以下步骤恢复（会先自动备份，不会直接删数据）：');
    console.error('  cd E:\\dev\\ladder\\apps\\api');
    console.error('  npm run db:recover        # 自动备份 + 清理 stale pid + 校验初始化');
    console.error('  npm run db:backup         # 仅备份当前 pgdata');
    process.exit(1);
  }
  console.log(`[pglite] database ready, data dir: ${dataDir}`);

  try {
    server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
    await server.start();
  } catch (err) {
    console.error(`[pglite] TCP 服务启动失败：${err?.message || err}`);
    // 启动失败也要把数据库关干净，避免留下半开状态
    await db.close().catch(() => {});
    process.exit(1);
  }

  console.log(`[pglite] PostgreSQL wire server listening on 127.0.0.1:${port}`);
  console.log(`[pglite] connect: postgresql://postgres:postgres@127.0.0.1:${port}/ladder`);

  // 每 60s 主动 checkpoint，减少异常退出时未落盘的 WAL 量；失败静默容错，不影响服务
  checkpointTimer = setInterval(async () => {
    try {
      await db.exec('CHECKPOINT');
    } catch {
      // 忽略：checkpoint 失败不应影响正常读写
    }
  }, 60 * 1000);
  if (typeof checkpointTimer.unref === 'function') checkpointTimer.unref();
}

// SIGINT/SIGTERM: 常规停止；SIGHUP/SIGBREAK: Windows 控制台关闭/中断场景
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => {
    shutdown(sig);
  });
}

// 事件循环自然结束时也走同一套关闭流程
process.on('beforeExit', () => {
  if (!shuttingDown) shutdown('beforeExit');
});

// Windows 下 taskkill 不带 /F 无法给控制台程序发送可被捕获的信号，
// 额外支持向 stdin 写入 shutdown 以触发同一优雅关闭流程（便于脚本化验证）
// 分离启动（如 WMI/计划任务）时 stdin 不可用，读它会抛错并使进程秒退，需吞掉错误
process.stdin.on('error', () => {});
process.stdin.on('data', (chunk) => {
  if (chunk.toString().trim().toLowerCase() === 'shutdown') shutdown('stdin');
});

await main().catch((err) => {
  console.error(`[pglite] 启动异常：${err?.message || err}`);
  process.exit(1);
});
