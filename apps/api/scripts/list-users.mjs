import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const u = await p.user.findMany({ select: { id: true, email: true } });
console.log(JSON.stringify(u, null, 2));
await p.$disconnect();
