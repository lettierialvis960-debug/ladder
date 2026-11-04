import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const subs = await p.pushSubscription.findMany({});
const u = await p.user.findFirst({ where: { email: 'demo_ladder@test.local' } });
console.log(JSON.stringify({
  userId: u?.id,
  subCount: subs.length,
  reminderEnabled: u?.reminderEnabled,
  reminderTime: u?.reminderTime,
}, null, 2));
await p.$disconnect();
