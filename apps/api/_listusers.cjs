const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const users = await p.user.findMany({ select: { id: true, email: true, createdAt: true } });
  console.log('=== 所有用户 ===');
  users.forEach((u) => {
    const tag = u.email.startsWith('e2e_') ? '[E2E]' : u.email.startsWith('demo_') ? '[DEMO]' : '[PROD]';
    console.log(`${tag} ${u.email} | ${u.id}`);
  });
  console.log(`\n总数: ${users.length}`);
})().finally(() => p.$disconnect());
