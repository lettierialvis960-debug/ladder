// 嵌入式 PostgreSQL 服务器（PGlite），提供 TCP 连接供 Prisma 使用。
// 数据持久化到 prisma/pgdata，重启不丢数据。
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// pgdata 默认放 prisma/pgdata，但沙箱限制 E: 盘写入时可通过 PG_DATA_DIR 覆盖
const dataDir = process.env.PG_DATA_DIR || join(__dirname, 'prisma', 'pgdata');

const port = Number(process.env.PG_PORT || 5432);

const db = new PGlite(dataDir);
await db.waitReady;
console.log(`[pglite] database ready, data dir: ${dataDir}`);

const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
await server.start();
console.log(`[pglite] PostgreSQL wire server listening on 127.0.0.1:${port}`);
console.log(`[pglite] connect: postgresql://postgres:postgres@127.0.0.1:${port}/ladder`);
