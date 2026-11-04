// 一次性 ETL：SQLite dev.db → PostgreSQL（Prisma Client）
// 按外键拓扑顺序逐表导入，JSON 字段保持 String（保守方案不升级 Json 类型）
import initSqlJs from 'sql.js';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlitePath = join(__dirname, 'prisma', 'dev.db.sqlite.bak');

const SQL = await initSqlJs();
const sqliteDb = new SQL.Database(readFileSync(sqlitePath));
const prisma = new PrismaClient();

// 读取某张表的所有行
function readTable(name) {
  const res = sqliteDb.exec(`SELECT * FROM "${name}"`);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

// 写入顺序：按外键依赖拓扑排序（先父表后子表）
const order = [
  'Level', 'User',
  'ContentPack', 'ContentItem', 'Sentence',
  'Plan', 'Stage',
  'ListeningSession', 'DictationAttempt', 'WrongWord',
  'ConfusedMark', 'FavoriteSentence',
  'DialogueSession', 'DialogueMessage',
  'SpeakingRecord', 'DailyCheckin', 'PushSubscription',
  'ReviewLog', 'QuizSession',
];

let total = 0;
for (const table of order) {
  const rows = readTable(table);
  if (!rows.length) { console.log(`[skip] ${table} (0 rows)`); continue; }
  // SQLite Boolean 存为 0/1，Prisma createMany 接受 boolean，需转换
  // 但 Prisma schema 里 Boolean 字段在 PG 是 boolean 类型，0/1 不行，需转 true/false
  const modelName = table.charAt(0).toLowerCase() + table.slice(1);
  // 对每行：把数字 0/1 转 boolean？Prisma 会按字段类型转换，但 createMany 用原始值可能失败
  // 保险起见，遍历字段，对 schema 中 Boolean 类型字段做转换
  const fixed = rows.map((r) => {
    const o = { ...r };
    const boolFields = new Set([
      'reminderEnabled', 'inListeningList', 'inDictationList',
      'mastered', 'resolved', 'done', 'passed', 'remembered',
    ]);
    const dateFields = new Set(['createdAt', 'updatedAt', 'completedAt', 'dueAt']);
    for (const k of Object.keys(o)) {
      // Boolean: SQLite 存 0/1 → true/false
      if (boolFields.has(k) && (o[k] === 0 || o[k] === 1)) {
        o[k] = o[k] === 1;
      }
      // DateTime: SQLite 存整数毫秒戳 → ISO 字符串；null/空值保持 null
      if (dateFields.has(k)) {
        const v = o[k];
        if (v === null || v === undefined || v === '') {
          o[k] = null;
        } else if (typeof v === 'number') {
          o[k] = new Date(v).toISOString();
        } else if (typeof v === 'string') {
          // 已经是 ISO 字符串或可解析日期
          const d = new Date(v);
          o[k] = isNaN(d.getTime()) ? null : d.toISOString();
        }
      }
    }
    return o;
  });
  await prisma[modelName].createMany({ data: fixed, skipDuplicates: true });
  console.log(`[ok] ${table}: ${fixed.length} rows`);
  total += fixed.length;
}

console.log(`\nETL done: ${total} rows migrated.`);
sqliteDb.close();
await prisma.$disconnect();
