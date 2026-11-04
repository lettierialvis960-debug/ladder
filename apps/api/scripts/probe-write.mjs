import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
try {
  const r = await p.pushSubscription.create({
    data: { userId: 'cmvk8osc9001i126t9x4y0yxh', endpoint: 'https://fake.test/probe-' + Date.now(), p256dh: 'x', auth: 'y' },
  });
  console.log('CREATE OK', r.id);
  const c = await p.pushSubscription.count();
  console.log('count =', c);
  await p.pushSubscription.delete({ where: { id: r.id } });
  console.log('deleted probe');
} catch (e) {
  console.error('ERR:', e.message.split('\n').slice(-3).join(' | '));
}
await p.$disconnect();
