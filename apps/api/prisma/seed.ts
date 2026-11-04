/**
 * 种子数据：L1/L2/L3 三级 + 每级 1 个示例内容包（骨架验证用）。
 * 正式内容按 rules.MIN_PACKS_PER_LEVEL ≥3 由内容运营入库（决策 D2：公开资源 + 版权审查）。
 * 运行：pnpm db:seed
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const levels = [
    { code: 'L1', name: '初阶', audience: '小学、初中', description: '课本同步短对话、课堂用语、简单生活场景；慢速高频词短句' },
    { code: 'L2', name: '中阶', audience: '高中、大学（基础）', description: '日常生活对话、新闻时事；常速中长句' },
    { code: 'L3', name: '高阶', audience: '大学（学术）、托福、雅思', description: '学术讲座、托福/雅思风格材料；学术词汇长段落' },
  ];
  for (const lv of levels) {
    await prisma.level.upsert({ where: { code: lv.code }, update: lv, create: lv });
  }

  // 示例包：每级 1 个，含 1 篇材料 + 3 个句切片（音频为占位路径，内容运营替换）
  const packs = [
    { levelCode: 'L1', title: '校园日常（示例）', tags: 'DAILY_LIFE' },
    { levelCode: 'L2', title: '每周新闻精选（示例）', tags: 'NEWS,DAILY_LIFE' },
    { levelCode: 'L3', title: '学术讲座精选（示例）', tags: 'ACADEMIC,EXAM_PREP' },
  ];
  for (const p of packs) {
    const pack = await prisma.contentPack.create({
      data: {
        ...p,
        items: {
          create: [{
            title: `${p.title} · 第 1 篇`,
            audioUrl: '/uploads/sample/full.wav',
            durationSec: 45,
            transcript: 'The museum opens at nine in the morning. She has already finished most of the report. We will meet again next week.',
            translation: '博物馆上午九点开门。她已经完成了报告的大部分。我们下周再见。',
            sentences: {
              create: [
                { seq: 1, text: 'The museum opens at nine in the morning.', translation: '博物馆上午九点开门。', audioUrl: '/uploads/sample/s1.wav' },
                { seq: 2, text: 'She has already finished most of the report.', translation: '她已经完成了报告的大部分。', audioUrl: '/uploads/sample/s2.wav' },
                { seq: 3, text: 'We will meet again next week.', translation: '我们下周再见。', audioUrl: '/uploads/sample/s3.wav' },
              ],
            },
          }],
        },
      },
    });
    console.log(`seeded pack: ${pack.title}`);
  }
}

main().finally(() => prisma.$disconnect());
