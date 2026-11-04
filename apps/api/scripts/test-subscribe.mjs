import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

// 模拟 controller 传入的 dto 结构（经过 ValidationPipe whitelist 后）
const dto = {
  endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/test-' + Math.random(),
  keys: {
    p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-IbqrsCs7k4vmwo-mkeQhbjE3rs3dqYGj8xIR46ArguYQrYu3GZ2zjesiTKJs',
    auth: 'BoQSG2z5mRlxW16pVrRzY7zYv_9k2aX3vZ4o5s8t7w5',
  },
};

const user = await p.user.findFirst({ where: { email: 'demo_ladder@test.local' } });
const userId = user.id;
console.log('userId:', userId);
console.log('dto:', JSON.stringify(dto));

try {
  const r = await p.pushSubscription.upsert({
    where: { endpoint: dto.endpoint },
    create: { userId, endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
    update: { userId, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
  });
  console.log('subscribe OK:', r.id);
} catch (e) {
  console.error('subscribe ERR:', e.message, e.code, e.meta);
}

await p.$disconnect();
