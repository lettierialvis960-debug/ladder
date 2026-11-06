/**
 * 清单口径统一：官方材料 inListeningList / inDictationList 不一致排查与修复。
 * 用法：node scripts/fix-list-flags.mjs [--apply]
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

async function main() {
  const mismatched = await prisma.contentItem.findMany({
    where: {
      OR: [
        { inListeningList: true, inDictationList: false },
        { inListeningList: false, inDictationList: true },
      ],
    },
    select: {
      id: true, title: true, inListeningList: true, inDictationList: true,
      pack: { select: { title: true, ownerId: true } },
    },
    orderBy: { id: 'asc' },
  });

  console.log(`口径不一致材料共 ${mismatched.length} 篇：`);
  for (const it of mismatched) {
    const scope = it.pack.ownerId ? '自定义' : '官方';
    console.log(`  [${scope}] ${it.title} 《${it.pack.title}》 listening=${it.inListeningList} dictation=${it.inDictationList}`);
  }

  // 仅修官方包：以听力清单为准（用户此前已将其移出听力清单）
  const targets = mismatched.filter((it) => !it.pack.ownerId && !it.inListeningList && it.inDictationList);
  console.log(`\n待修复（官方 · 仅在听写清单）${targets.length} 篇`);
  if (apply) {
    for (const it of targets) {
      await prisma.contentItem.update({ where: { id: it.id }, data: { inDictationList: false } });
      console.log(`  已修复 ${it.id} ${it.title} → inDictationList=false`);
    }
  } else {
    console.log('（dry-run，加 --apply 生效）');
  }
}

main()
  .catch((e) => { console.error('FAILED:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
