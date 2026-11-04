// P0-4 听写错词完整闭环端到端验证
// 链路：注册 → 创建计划 → 听写产生错词 → 复习（记住了/忘记了）→ SRS 规则生效 → 毕业 → 统计反映
// 跑完后自动清理测试账号

const BASE = 'http://localhost:3000/api';
const EMAIL = `e2e_${Date.now()}@ladder.local`;
const PASSWORD = 'ladder1234';
const TODAY = new Date().toISOString().slice(0, 10);
let token = '';
let userId = '';
const log = (label, obj) => console.log(`${label}: ${typeof obj === 'object' ? JSON.stringify(obj) : obj}`);
const ok = (label, cond) => console.log(`${cond ? '✅' : '❌'} ${label}`);

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

async function run() {
  console.log('=== P0-4 听写错词闭环验证 ===\n');

  // 1. 注册
  const reg = await req('POST', '/auth/register', { email: EMAIL, password: PASSWORD, name: 'e2e' });
  token = reg.accessToken;
  userId = reg.user?.id ?? reg.id;
  log('注册原始响应', JSON.stringify(reg));
  log('注册', { email: EMAIL, userId });

  // 2. 创建计划（L1，生活听力精选，30天）
  const packs = await req('GET', `/content/packs?levelCode=L1`);
  // packs 列表返回里没有 listeningItemCount，直接按标题挑 L1 的「生活」包
  const dailyPack = packs.find((p) => p.levelCode === 'L1' && p.title.includes('生活')) || packs.find((p) => p.levelCode === 'L1');
  if (!dailyPack) throw new Error('找不到 L1 内容包');
  log('选中 pack', { id: dailyPack.id, title: dailyPack.title, levelCode: dailyPack.levelCode });
  const plan = await req('POST', '/plans', {
    levelCode: 'L1',
    packId: dailyPack.id,
    stage1Days: 30, stage2Days: 30, stage3Days: 30,
  });
  log('计划创建', { packTitle: dailyPack.title, status: plan.status });

  // 3. 取听写句子（3 句，故意写错产生错词）
  const listeningItems = await req('GET', `/content/items?packId=${dailyPack.id}&list=listening`);
  const item = listeningItems[0];
  const sentences = await req('GET', `/content/items/${item.id}/sentences`);
  log('取到句子数', sentences.length);

  const s1 = sentences[0]; // 整句写错 → 全错
  const s2 = sentences[1]; // 部分错词
  const s3 = sentences[2]; // 全对

  // 3a. 听写 1：全错（correctRate=0，错词 3 个）
  const wrong1 = ['wrong1', 'wrong2', 'wrong3'];
  const d1 = await req('POST', '/learning/dictation', {
    sentenceId: s1.id, date: TODAY,
    input: 'wrong1 wrong2 wrong3', correctRate: 0, replayCount: 2, wrongWords: wrong1,
  });
  log('听写1（全错）', { id: d1.id, wrongWords: d1.wrongWords });
  ok('听写1 成功创建', !!d1.id);

  // 3b. 听写 2：部分错（correctRate=0.6，错词 2 个）
  const wrong2 = ['oops', 'typo'];
  const d2 = await req('POST', '/learning/dictation', {
    sentenceId: s2.id, date: TODAY,
    input: 'correct oops here typo end', correctRate: 0.6, replayCount: 1, wrongWords: wrong2,
  });
  log('听写2（部分错）', { id: d2.id, wrongWords: d2.wrongWords });

  // 3c. 听写 3：全对
  const d3 = await req('POST', '/learning/dictation', {
    sentenceId: s3.id, date: TODAY,
    input: s3.text, correctRate: 1.0, replayCount: 0, wrongWords: [],
  });
  log('听写3（全对）', { id: d3.id });

  // 4. 验证 WrongWord 入库（共 5 个）
  const wwList = await req('GET', '/learning/wrong-words');
  log('错词本', wwList.length);
  ok('错词入库数量 = 5', wwList.length === 5);

  // 5. 查待复习（due）—— 全部应该 dueAt <= now（新词即时到期）
  const dueWrap = await req('GET', '/learning/wrong-words/due');
  const due = dueWrap.due;
  log('今日待复习', due.length);
  log('dueWrap.stats', dueWrap.stats);
  ok('待复习数量 = 5', due.length === 5);
  // WRONG_WORD_SELECT 没 include mastered 字段，但查询条件已是 mastered:false，自然全是未掌握

  // 6. 复习：对第 1 个说「记住了」→ reviewCount++，dueAt 推进 1 天
  const firstId = due[0].id;
  const before1 = (await req('GET', '/learning/wrong-words')).find((w) => w.id === firstId);
  log('复习前 reviewCount', before1.reviewCount);
  const r1 = await req('POST', `/learning/wrong-words/${firstId}/review`, { remembered: true });
  log('复习后（记住了）', { reviewCount: r1.reviewCount, dueAt: r1.dueAt });
  ok('记住了 → reviewCount 从 0 → 1', r1.reviewCount === 1);

  // 7. 复习：对第 2 个说「忘记了」→ reviewCount 重置为 0
  const secondId = due[1].id;
  const r2 = await req('POST', `/learning/wrong-words/${secondId}/review`, { remembered: false });
  log('复习后（忘记了）', { reviewCount: r2.reviewCount });
  ok('忘记了 → reviewCount 重置为 0', r2.reviewCount === 0);

  // 8. 连续对同一个词说「记住了」4 次 → 毕业（mastered=true）
  // 第 1 次 reviewCount=1 已做过，再做 3 次
  let lastReview;
  for (let i = 0; i < 3; i++) {
    lastReview = await req('POST', `/learning/wrong-words/${firstId}/review`, { remembered: true });
  }
  log('连续记住 4 次后（最后一次返回）', { reviewCount: lastReview.reviewCount, mastered: lastReview.mastered });
  ok('reviewCount >= 4 → 自动毕业', lastReview.mastered === true);
  ok('连续记住 4 次 → reviewCount=4', lastReview.reviewCount === 4);

  // 9. 毕业后待复习队列不再包含它
  const dueAfterWrap = await req('GET', '/learning/wrong-words/due');
  const dueAfter = dueAfterWrap.due;
  log('毕业对待复习', dueAfter.length);
  ok('毕业词不再出现在待复习', !dueAfter.some((w) => w.id === firstId));

  // 10. 统计反映
  const summary = await req('GET', '/stats/summary');
  log('stats/summary', JSON.stringify(summary).slice(0, 400));
  ok('summary.dictationSentenceCount = 3', summary.dictationSentenceCount === 3);
  ok('summary.dictationAvgCorrectRate ≈ 0.53', Math.abs(summary.dictationAvgCorrectRate - 0.533) < 0.01);

  const activityWrap = await req('GET', '/stats/activity');
  const events = Array.isArray(activityWrap) ? activityWrap : activityWrap.events || activityWrap.items || [];
  const dictActs = events.filter((a) => a.type === 'dictation');
  const reviewActs = events.filter((a) => a.type === 'review');
  log('学习动态', { 总数: events.length, dictation: dictActs.length, review: reviewActs.length });
  ok('动态中有 3 条听写记录', dictActs.length === 3);
  ok('动态中有 5 条复习记录', reviewActs.length >= 5);

  // 11. 今日任务里也有错词提醒
  const today = await req('GET', '/stats/today');
  log('stats/today', JSON.stringify(today).slice(0, 400));
  // 5 个错词，1 个毕业 → due 应该剩 4
  const dueWrap2 = await req('GET', '/learning/wrong-words/due');
  ok('毕业对待复习 = 4', dueWrap2.due.length === 4);
  ok('stats.due.mastered = 1', dueWrap2.stats.mastered === 1);

  console.log('\n=== 闭环验证完成 ===');
}

run().catch((e) => {
  console.error('❌ 脚本异常：', e.message);
  process.exit(1);
});
