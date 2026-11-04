import fs from 'node:fs';

const f = 'E:/dev/ladder/apps/api/dist/modules/push/push.controller.js';
let c = fs.readFileSync(f, 'utf8');

// 给 subscribe 加 try-catch log
const oldSubscribe = "subscribe(userId, dto) { return this.push.subscribe(userId, dto); }";
const newSubscribe = "subscribe(userId, dto) { try { return this.push.subscribe(userId, dto); } catch(e) { console.error('SUBSCRIBE ERR in ctrl:', e.message, e.stack); throw e; } }";
c = c.replace(oldSubscribe, newSubscribe);

fs.writeFileSync(f, c);
console.log('patched');
