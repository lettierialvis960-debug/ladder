const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const packs = await p.contentPack.findMany({ select: { id: true, title: true, levelCode: true } });
  packs.forEach((x) => console.log(`${x.id} | ${x.levelCode} | ${x.title}`));
})().finally(() => p.$disconnect());
