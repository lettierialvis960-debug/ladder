import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
// 清理所有订阅（让用户浏览器重新订阅）
const r = await p.pushSubscription.deleteMany({});
console.log(`deleted ${r.count} subscriptions`);
await p.$disconnect();
