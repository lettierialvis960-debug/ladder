import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const subs = await p.pushSubscription.findMany({ where: { userId: 'cmvk8osc9001i126t9x4y0yxh' } });
console.log(`Total subscriptions for demo user: ${subs.length}`);
for (const s of subs) {
  const isReal = !s.endpoint.includes('test.example.com') && !s.endpoint.includes('test-0.');
  console.log(`  ${isReal ? 'REAL' : 'FAKE'}: ${s.endpoint.slice(0, 70)}... p256dh_len=${s.p256dh.length}`);
}
await p.$disconnect();
