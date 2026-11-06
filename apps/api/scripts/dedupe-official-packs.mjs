/**
 * 官方示例包去重：同一标题的多个包，只保留「引用最多 / 最早创建」的一个，
 * 其余仅在「零引用」时删除（有任何学习记录的一律跳过并报告）。
 *
 * 用法：node scripts/dedupe-official-packs.mjs [--apply]
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';

const HERE = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const env = readFileSync(join(HERE, '..', '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
    if (m) { process.env.DATABASE_URL = m[1].trim(); break; }
  }
}

const apply = process.argv.includes('--apply');
const prisma = new PrismaClient();

async function refsOf(packId) {
  const itemWhere = { item: { packId } };
  const sentenceWhere = { sentence: { item: { packId } } };
  // PGlite 桥对并发敏感，逐条串行查询
  const plans = await prisma.plan.count({ where: { packId } });
  const listen = await prisma.listeningSession.count({ where: itemWhere });
  const speak = await prisma.speakingRecord.count({
    where: { OR: [{ item: { packId } }, { sentence: { item: { packId } } }] },
  });
  const dictate = await prisma.dictationAttempt.count({ where: sentenceWhere });
  const wrong = await prisma.wrongWord.count({ where: sentenceWhere });
  const confused = await prisma.confusedMark.count({ where: sentenceWhere });
  const fav = await prisma.favoriteSentence.count({ where: sentenceWhere });
  return { plans, listen, speak, dictate, wrong, confused, fav, total: plans + listen + speak + dictate + wrong + confused + fav };
}

async function main() {
  const packs = await prisma.contentPack.findMany({
    where: { ownerId: null },
    select: { id: true, title: true, levelCode: true, items: { select: { id: true } } },
  });

  const byTitle = new Map();
  for (const p of packs) {
    const key = `${p.levelCode}::${p.title}`;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(p);
  }

  let deleted = 0;
  let keptGroups = 0;

  for (const [key, list] of byTitle) {
    if (list.length < 2) continue;
    keptGroups++;
    const scored = [];
    for (const p of list) {
      const refs = await refsOf(p.id);
      scored.push({ pack: p, refs });
    }
    // 保留：引用最多；并列时 id 升序（cuid 近似创建时间）
    scored.sort((a, b) => b.refs.total - a.refs.total || (a.pack.id < b.pack.id ? -1 : 1));
    const keep = scored[0];
    console.log(`\n[${key}] 共 ${list.length} 份 → 保留 ${keep.pack.id}（引用 ${keep.refs.total}，材料 ${keep.pack.items.length}）`);
    for (const s of scored.slice(1)) {
      const r = s.refs;
      const detail = `plans=${r.plans} listen=${r.listen} speak=${r.speak} dictate=${r.dictate} wrong=${r.wrong} confused=${r.confused} fav=${r.fav}`;
      if (r.total > 0) {
        console.log(`  跳过 ${s.pack.id}：有引用（${detail}）`);
        continue;
      }
      console.log(`  删除 ${s.pack.id}（材料 ${s.pack.items.length}，无引用）`);
      if (apply) {
        const itemIds = s.pack.items.map((i) => i.id);
        await prisma.sentence.deleteMany({ where: { itemId: { in: itemIds } } });
        await prisma.contentItem.deleteMany({ where: { id: { in: itemIds } } });
        await prisma.contentPack.delete({ where: { id: s.pack.id } });
        deleted++;
      }
    }
  }

  console.log(`\n${apply ? '已删除' : '可删除'} ${deleted || ''}${apply ? '' : '(dry-run)'} 个重复包；涉及 ${keptGroups} 组`);
}

main()
  .catch((e) => { console.error('FAILED:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
