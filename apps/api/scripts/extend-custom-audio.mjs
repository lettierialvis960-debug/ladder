/**
 * 扩充三篇自定义听力材料（校园生活 / 日常生活 / 时政新闻）：
 *   逐句慢速切片 sNN.mp3(-15%) + 快速切片 fNN.mp3(-5%)
 *   → pass-slow.mp3 / pass-fast.mp3（各自按句拼接，句边界精确可知）
 *   → full.mp3（慢/快 pass 交替拼接至 ≥1200s，逐句时间轴累加）
 *   → 沿用原 ContentItem id 更新 transcript/translation/durationSec/timelineJson，追加新句子。
 *
 * 幂等：音频按文件缓存跳过；DB 用 upsert（seq<=6 的旧行保留 id，只更新文本字段）。
 * 运行：node scripts/extend-custom-audio.mjs [--smoke]
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import mp3Duration from 'mp3-duration';
import { PrismaClient } from '@prisma/client';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.STORAGE_LOCAL_ROOT || 'E:\\dev\\ladder\\data\\uploads';
const VOICE = 'en-US-JennyNeural';
const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const TARGET_SEC = 1200;
const LANES = 4;
const URL_PREFIX = '/uploads';

if (!process.env.DATABASE_URL) {
  const env = readFileSync(join(HERE, '..', '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
    if (m) { process.env.DATABASE_URL = m[1].trim(); break; }
  }
}
if (!process.env.STORAGE_LOCAL_ROOT) {
  const env = readFileSync(join(HERE, '..', '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*STORAGE_LOCAL_ROOT\s*=\s*"?([^"\r\n]+)"?/);
    if (m) { process.env.STORAGE_LOCAL_ROOT = m[1].trim(); break; }
  }
}

const durOf = (buf) => new Promise((res, rej) => mp3Duration(buf, (e, d) => (e ? rej(e) : res(d))));

/** 单次合成（带重试 + 超时）；每 lane 独立连接 */
async function synth(text, rate) {
  for (let i = 0; i < 4; i++) {
    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(VOICE, FORMAT);
      const { audioStream } = await tts.toStream(text, { rate });
      const chunks = [];
      const readAll = (async () => { for await (const c of audioStream) chunks.push(c); })();
      await Promise.race([
        readAll,
        new Promise((_, rej) => setTimeout(() => rej(new Error('tts timeout')), 30000)),
      ]);
      const buf = Buffer.concat(chunks);
      if (buf.length < 500) throw new Error(`too small: ${buf.length}`);
      return buf;
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

/* ---------------- 三篇正文（前 6 句与原库一致，追加扩写） ---------------- */
const ARTICLES = [
  {
    title: '校园生活 · Campus Life',
    dir: '9c81a32d-bb52-4e36-a681-1f6aeb41ddb8',
    itemId: 'cmw4fel18001511u3z34ceotb',
    sentences: [
      { text: "Every morning, students arrive at school before eight o'clock.", zh: '每天早上，学生们八点前到校。' },
      { text: 'The library is quiet, and many students study there after class.', zh: '图书馆很安静，很多学生放学后在那里自习。' },
      { text: 'In the afternoon, the school team practices basketball on the playground.', zh: '下午，校队在操场上练习篮球。' },
      { text: 'Our English teacher asks us to read aloud in every class.', zh: '我们的英语老师要求每节课都大声朗读。' },
      { text: 'After the final bell, some students join clubs, and others walk home together.', zh: '放学铃响后，一些学生参加社团，另一些一起步行回家。' },
      { text: 'I like my school because my friends and teachers are kind.', zh: '我喜欢我的学校，因为朋友和老师都很友善。' },
      { text: 'Our classroom is on the second floor.', zh: '我们的教室在二楼。' },
      { text: 'There are forty students in my class.', zh: '我们班有四十名学生。' },
      { text: 'We have four classes in the morning.', zh: '我们上午有四节课。' },
      { text: 'The first class starts at eight ten.', zh: '第一节课八点十分开始。' },
      { text: 'My favorite subject is English.', zh: '我最喜欢的科目是英语。' },
      { text: 'I also like math and history.', zh: '我也喜欢数学和历史。' },
      { text: 'Our math teacher writes on the blackboard slowly.', zh: '我们的数学老师慢慢地在黑板上写字。' },
      { text: 'We take notes in our notebooks.', zh: '我们在笔记本上做笔记。' },
      { text: "At ten o'clock, we have a short break.", zh: '十点钟，我们有一次短暂的休息。' },
      { text: 'We go to the playground and relax.', zh: '我们去操场放松一下。' },
      { text: 'Some students play games and laugh.', zh: '一些学生玩游戏，开心地笑着。' },
      { text: 'Others buy water from the small shop.', zh: '另一些去小卖部买水。' },
      { text: 'The shop is next to the school gate.', zh: '小卖部在学校大门旁边。' },
      { text: 'At noon, we have lunch in the dining hall.', zh: '中午，我们在食堂吃午饭。' },
      { text: 'The food is simple but healthy.', zh: '饭菜很简单，但很健康。' },
      { text: 'I usually eat rice, vegetables, and chicken.', zh: '我通常吃米饭、蔬菜和鸡肉。' },
      { text: 'I sit with my best friend Wang Tao.', zh: '我和我最好的朋友王涛坐在一起。' },
      { text: 'We talk about our morning classes.', zh: '我们聊上午的课。' },
      { text: 'After lunch, we walk around the school garden.', zh: '午饭后，我们在学校花园里散步。' },
      { text: 'The garden has many green trees and flowers.', zh: '花园里有很多绿树和鲜花。' },
      { text: 'Sometimes we read books under a tree.', zh: '有时我们在树下看书。' },
      { text: 'In the science class, we do simple experiments.', zh: '科学课上，我们做简单的实验。' },
      { text: 'Our teacher shows us a small model of a plant.', zh: '老师给我们看一株植物的小模型。' },
      { text: 'We learn how plants grow.', zh: '我们学习植物是怎样生长的。' },
      { text: 'We also study one foreign language.', zh: '我们还学习一门外语。' },
      { text: 'English helps us learn about the world.', zh: '英语帮助我们了解世界。' },
      { text: 'On Wednesday, we have a music class.', zh: '星期三我们有音乐课。' },
      { text: 'We sing English songs together.', zh: '我们一起唱英文歌。' },
      { text: 'The music room is bright and clean.', zh: '音乐教室明亮又干净。' },
      { text: 'Our music teacher plays the piano well.', zh: '我们的音乐老师钢琴弹得很好。' },
      { text: 'On Thursday, we have an art class.', zh: '星期四我们有美术课。' },
      { text: 'We draw pictures with colored pencils.', zh: '我们用彩色铅笔画画。' },
      { text: 'Last week, I drew a picture of my school.', zh: '上周，我画了一幅我们学校的画。' },
      { text: 'The teacher put it on the wall.', zh: '老师把它贴在了墙上。' },
      { text: 'I felt very happy that day.', zh: '那天我感到非常开心。' },
      { text: 'We have a sports meeting every autumn.', zh: '我们每年秋天都有运动会。' },
      { text: 'All students run and jump on the playground.', zh: '所有学生都在操场上跑和跳。' },
      { text: 'My class won two games last year.', zh: '去年我们班赢了两场比赛。' },
      { text: 'We shouted and cheered for our team.', zh: '我们为我们的队伍呐喊加油。' },
      { text: 'Our school has a small computer room.', zh: '我们学校有一间小计算机房。' },
      { text: 'We learn to type and use the internet safely.', zh: '我们学习打字和安全地上网。' },
      { text: 'The internet is useful for our study.', zh: '互联网对我们的学习很有用。' },
      { text: 'After school, I sometimes stay for the English club.', zh: '放学后，我有时留下来参加英语社团。' },
      { text: 'We practice speaking and play word games.', zh: '我们练习口语，玩单词游戏。' },
      { text: 'The club ends at five thirty.', zh: '社团五点半结束。' },
      { text: 'Then I take the bus home.', zh: '然后我坐公交车回家。' },
      { text: 'Before I leave, I say goodbye to my teacher.', zh: '离开前，我和老师道别。' },
      { text: 'She says, "See you tomorrow."', zh: '她说：“明天见。”' },
      { text: 'My schoolbag is heavy but my heart is light.', zh: '我的书包很重，但我的心情很轻松。' },
      { text: 'I learn something new every day.', zh: '我每天都学到新东西。' },
      { text: 'A good school is like a warm family.', zh: '一所好学校就像一个温暖的家。' },
      { text: 'My friends and teachers make it special.', zh: '我的朋友和老师让它变得特别。' },
    ],
  },
  {
    title: '日常生活 · Daily Life',
    dir: '0355e9af-f799-487e-a3f1-02a2ab47905d',
    itemId: 'cmw4feq23001d11u3fq4qk74h',
    sentences: [
      { text: 'I usually get up at seven and make a simple breakfast.', zh: '我通常七点起床，做一顿简单的早餐。' },
      { text: 'On weekdays, I take the bus to work and listen to music on the way.', zh: '工作日我坐公交上班，路上听音乐。' },
      { text: 'In the evening, I cook dinner and talk with my family.', zh: '晚上我做饭，和家人聊天。' },
      { text: 'On weekends, I go to the market to buy fresh vegetables and fruit.', zh: '周末我去市场买新鲜蔬菜和水果。' },
      { text: 'Before bed, I read a few pages of a book to relax.', zh: '睡前我读几页书放松一下。' },
      { text: 'Simple routines help me feel calm and ready for the next day.', zh: '简单的日常让我心态平静，为第二天做好准备。' },
      { text: 'My day starts with a glass of warm water.', zh: '我的一天从一杯温水开始。' },
      { text: 'Then I open the curtains and let in the light.', zh: '然后我拉开窗帘，让阳光照进来。' },
      { text: 'I make eggs and toast for breakfast.', zh: '我早餐做鸡蛋和烤面包。' },
      { text: 'Sometimes I drink a cup of tea.', zh: '有时我喝一杯茶。' },
      { text: 'I check the weather before I go out.', zh: '出门前我查看天气。' },
      { text: 'If it is cold, I wear a warm coat.', zh: '如果天冷，我就穿一件暖和的外套。' },
      { text: 'The bus stop is a five-minute walk from my home.', zh: '公交车站离家步行五分钟。' },
      { text: 'The bus is often full in the morning.', zh: '早晨公交车通常很挤。' },
      { text: 'I stand and look at the city streets.', zh: '我站着看城市的街道。' },
      { text: 'I arrive at my office at eight forty.', zh: '我八点四十到办公室。' },
      { text: 'I work at a small design company.', zh: '我在一家小型设计公司工作。' },
      { text: 'My job is to draw pictures for posters.', zh: '我的工作是为海报画图。' },
      { text: 'I have a friendly desk next to the window.', zh: '我的桌子靠窗，很舒服。' },
      { text: 'In the morning, I answer emails and plan my work.', zh: '上午我回复邮件，安排工作。' },
      { text: 'At noon, I eat lunch with my workmates.', zh: '中午我和同事一起吃午饭。' },
      { text: 'We often go to a small noodle shop.', zh: '我们常去一家小面馆。' },
      { text: 'The noodles are hot and cheap.', zh: '面条又热又便宜。' },
      { text: 'After lunch, I walk for ten minutes.', zh: '午饭后我散步十分钟。' },
      { text: 'Walking helps me think clearly.', zh: '散步让我思路清晰。' },
      { text: 'In the afternoon, I finish my designs.', zh: '下午我完成我的设计。' },
      { text: 'My manager checks my work and gives advice.', zh: '经理检查我的工作并给建议。' },
      { text: 'I try to finish work before six.', zh: '我尽量在六点前完成工作。' },
      { text: 'Then I take the bus home again.', zh: '然后我又坐公交车回家。' },
      { text: 'On the way, I buy some bread for breakfast.', zh: '路上我买些面包当早餐。' },
      { text: 'At home, I change into comfortable clothes.', zh: '到家后，我换上舒服的衣服。' },
      { text: 'I clean the kitchen and water the plants.', zh: '我清理厨房，给植物浇水。' },
      { text: 'My plants grow well in the sun.', zh: '我的植物在阳光下长得很好。' },
      { text: 'I cook rice, soup, and two dishes.', zh: '我做米饭、汤和两个菜。' },
      { text: 'My family eats dinner together at seven.', zh: '我们一家人七点一起吃晚饭。' },
      { text: 'We talk about our day at the table.', zh: '我们在饭桌上聊各自的一天。' },
      { text: 'My mother tells funny stories.', zh: '妈妈讲有趣的故事。' },
      { text: 'My father washes the dishes after dinner.', zh: '晚饭后爸爸洗碗。' },
      { text: 'I help him dry the bowls.', zh: '我帮他把碗擦干。' },
      { text: 'Then we watch a little television.', zh: '然后我们看一会儿电视。' },
      { text: 'We do not watch for too long.', zh: '我们不会看太久。' },
      { text: 'At nine, I take a warm shower.', zh: '九点钟，我洗个热水澡。' },
      { text: 'I put my clothes away and set the alarm.', zh: '我把衣服收好，定好闹钟。' },
      { text: 'I write three things I did well today.', zh: '我写下今天做得很好的三件事。' },
      { text: 'This small habit makes me feel good.', zh: '这个小习惯让我感觉很好。' },
      { text: 'On Saturday, I clean my room from top to bottom.', zh: '星期六，我把房间彻底打扫一遍。' },
      { text: 'I wash my clothes and change the sheets.', zh: '我洗衣服，换床单。' },
      { text: 'In the afternoon, I meet my friend in the park.', zh: '下午，我在公园和朋友见面。' },
      { text: 'We walk around the lake and eat ice cream.', zh: '我们绕着湖散步，吃冰淇淋。' },
      { text: 'On Sunday, I visit my grandparents.', zh: '星期天，我去看望我的祖父母。' },
      { text: 'My grandmother makes dumplings for us.', zh: '奶奶为我们包饺子。' },
      { text: 'I learn how to fold them by hand.', zh: '我学着用手捏饺子。' },
      { text: 'In the evening, I plan the next week.', zh: '晚上，我安排下一周的事。' },
      { text: 'I write down my tasks and my goals.', zh: '我写下我的任务和目标。' },
      { text: 'I sleep before eleven every night.', zh: '我每天晚上十一点前睡觉。' },
      { text: 'Good sleep gives me energy.', zh: '良好的睡眠给我能量。' },
      { text: 'My life is simple, but it is full of small joys.', zh: '我的生活很简单，但充满了小小的快乐。' },
    ],
  },
  {
    title: '时政新闻 · City News',
    dir: '941b1864-d44e-430f-b78f-47f9bc42595c',
    itemId: 'cmw4fevky001l11u3rwsagge6',
    sentences: [
      { text: 'City leaders announced a new plan to improve public transport this year.', zh: '市领导宣布今年将推出改善公共交通的新计划。' },
      { text: 'According to the report, more buses will run on main roads during rush hours.', zh: '根据报告，高峰时段主干道将增开更多公交车。' },
      { text: 'The government also promised to build two new parks near the river.', zh: '政府还承诺在河边新建两座公园。' },
      { text: 'Officials said the project will cost about fifty million yuan.', zh: '官员表示该项目将耗资约五千万元。' },
      { text: 'Local residents can share their ideas at a public meeting next Monday.', zh: '当地居民可在下周一的一次公开会议上分享意见。' },
      { text: 'The first stage of the plan is expected to start in September.', zh: '该计划的第一阶段预计于九月启动。' },
      { text: 'The city has about two million people.', zh: '这座城市大约有两百万人。' },
      { text: 'Many of them take the subway to work.', zh: '他们中的许多人坐地铁上班。' },
      { text: 'The subway opens at half past five in the morning.', zh: '地铁早上五点半开始运营。' },
      { text: 'It closes at eleven at night.', zh: '它晚上十一点停运。' },
      { text: 'A new subway line will open next year.', zh: '一条新的地铁线路明年开通。' },
      { text: 'The line will connect the east and west parts of the city.', zh: '这条线路将连接城市的东部和西部。' },
      { text: 'Workers are building three new stations now.', zh: '工人们正在修建三个新车站。' },
      { text: 'The stations will have wide doors and bright lights.', zh: '车站将设有宽大的门和明亮的灯。' },
      { text: 'The city will also add more bike lanes.', zh: '城市还将增设更多自行车道。' },
      { text: 'These lanes will make riding safer.', zh: '这些车道会让骑行更安全。' },
      { text: 'More people are using shared bikes today.', zh: '如今越来越多人使用共享单车。' },
      { text: 'The city plans to plant more trees along the roads.', zh: '城市计划在道路两旁种更多树。' },
      { text: 'Trees make the streets cooler in summer.', zh: '树木让街道在夏天更凉爽。' },
      { text: 'A new library will open near the city center.', zh: '一座新图书馆将在市中心附近开放。' },
      { text: 'It will have free reading rooms for children.', zh: '它将为孩子们提供免费的阅读室。' },
      { text: 'The library will be open six days a week.', zh: '图书馆每周开放六天。' },
      { text: 'The city is fixing old roads this month.', zh: '本月城市正在修补旧道路。' },
      { text: 'Some roads will close for a short time.', zh: '一些道路将短期封闭。' },
      { text: 'Drivers should take other roads during the work.', zh: '施工期间司机应走其他道路。' },
      { text: 'The city will build a new sports center next spring.', zh: '城市将于明年春天建成一座新的体育中心。' },
      { text: 'It will have a swimming pool and a large playground.', zh: '它将有一个游泳池和一个大操场。' },
      { text: 'Young people can play football and basketball there.', zh: '年轻人可以在那里踢足球、打篮球。' },
      { text: 'The price for using the center will be low.', zh: '使用该中心的费用会很低。' },
      { text: 'The city wants more people to exercise.', zh: '城市希望更多人锻炼身体。' },
      { text: 'Every year, the city holds a summer festival.', zh: '每年，城市都会举办夏季文化节。' },
      { text: 'People can enjoy music and local food.', zh: '人们可以欣赏音乐和当地美食。' },
      { text: 'Last year, more than ten thousand people came.', zh: '去年，一万多人前来参加。' },
      { text: 'This year, the festival will last for three days.', zh: '今年，文化节将持续三天。' },
      { text: 'Small shops near the river will stay open late.', zh: '河边的店铺将营业到很晚。' },
      { text: 'The city will provide more buses for the festival.', zh: '城市将为文化节增开更多公交车。' },
      { text: 'The police will help keep the streets safe.', zh: '警察将协助维护街道安全。' },
      { text: 'Residents should follow the traffic rules.', zh: '居民应遵守交通规则。' },
      { text: 'The city is also working to keep the river clean.', zh: '城市也在努力保持河流清洁。' },
      { text: 'Volunteers collect rubbish near the water every Sunday.', zh: '志愿者每周日在河边捡垃圾。' },
      { text: 'Last month, they collected thirty bags of rubbish.', zh: '上个月，他们捡了三十袋垃圾。' },
      { text: 'The city will put more rubbish bins along the river.', zh: '城市将在河边放置更多垃圾桶。' },
      { text: 'Students will join the clean-up work in May.', zh: '学生们将在五月参加清洁工作。' },
      { text: 'Their parents can join too.', zh: '他们的父母也可以参加。' },
      { text: 'The local school will hold an art show about the city.', zh: '当地学校将举办一场关于这座城市的艺术展。' },
      { text: 'Students will paint pictures of their streets and parks.', zh: '学生们将画出他们眼中的街道和公园。' },
      { text: 'The show will open to the public in June.', zh: '展览将于六月向公众开放。' },
      { text: 'Tickets will be free for children under twelve.', zh: '十二岁以下儿童免票。' },
      { text: 'The city has opened a new help phone line.', zh: '城市开通了一条新的服务热线。' },
      { text: 'People can call it for questions about city services.', zh: '人们可以拨打它咨询城市服务问题。' },
      { text: 'The line is open from nine to five on weekdays.', zh: '热线在工作日上午九点到下午五点开通。' },
      { text: 'Calls are free for all residents.', zh: '所有居民拨打电话免费。' },
      { text: 'The city will share news on its website every week.', zh: '城市每周将在其网站上发布新闻。' },
      { text: 'Residents can read the news and send their ideas.', zh: '居民可以阅读新闻并发送自己的想法。' },
      { text: 'A city belongs to everyone who lives in it.', zh: '城市属于每一个在这里生活的人。' },
      { text: 'Small changes can make daily life better.', zh: '小小的改变能让日常生活更美好。' },
      { text: 'The city will report on the project again in October.', zh: '城市将在十月再次公布项目进展。' },
      { text: 'We can follow the news and take part.', zh: '我们可以关注新闻，参与其中。' },
    ],
  },
];

const pad = (n) => String(n).padStart(2, '0');
const url = (dir, file) => `${URL_PREFIX}/custom/${dir}/${file}`;

async function buildArticle(art, prisma) {
  const dir = join(ROOT, 'custom', art.dir);
  mkdirSync(dir, { recursive: true });
  const n = art.sentences.length;
  console.log(`\n== ${art.title}（${n} 句）-> ${dir}`);

  // 1) 慢速切片 sNN.mp3（-15%，缓存跳过）
  const slow = art.sentences.map((s, i) => ({ ...s, seq: i + 1, file: `s${pad(i + 1)}.mp3` }));
  const fast = art.sentences.map((s, i) => ({ ...s, seq: i + 1, file: `f${pad(i + 1)}.mp3` }));
  // 总共 2n 个切片任务，4 lane 限并发
  const tasks = [...slow.map((t) => ({ ...t, rate: '-15%' })), ...fast.map((t) => ({ ...t, rate: '-5%' }))];
  let done = 0;
  const laneWork = async (lane) => {
    for (const t of tasks.filter((_, idx) => idx % LANES === lane)) {
      const path = join(dir, t.file);
      if (!existsSync(path) || statSync(path).size < 1000) {
        const buf = await synth(t.text, t.rate);
        writeFileSync(path, buf);
      }
      done++;
      if (done % 20 === 0) console.log(`  切片 ${done}/${tasks.length}`);
    }
  };
  await Promise.all(Array.from({ length: LANES }, (_, l) => laneWork(l)));

  // 2) 测量每句时长
  const slowSec = [];
  const fastSec = [];
  for (let i = 1; i <= n; i++) {
    slowSec.push(await durOf(readFileSync(join(dir, `s${pad(i)}.mp3`))));
    fastSec.push(await durOf(readFileSync(join(dir, `f${pad(i)}.mp3`))));
  }
  console.log(`  单 pass: slow=${sum(slowSec).toFixed(1)}s fast=${sum(fastSec).toFixed(1)}s`);

  // 3) pass-slow / pass-fast（逐句拼接，保证句边界精确）
  const slowBuf = Buffer.concat(slow.map((t) => readFileSync(join(dir, t.file))));
  const fastBuf = Buffer.concat(fast.map((t) => readFileSync(join(dir, t.file))));
  writeFileSync(join(dir, 'pass-slow.mp3'), slowBuf);
  writeFileSync(join(dir, 'pass-fast.mp3'), fastBuf);

  // 4) full.mp3：慢/快交替，直到 ≥1200s；记录每句每次出现的起止秒
  const parts = [];
  const timeline = [];
  let offset = 0;
  let turn = 0;
  while (offset < TARGET_SEC) {
    const isSlow = turn % 2 === 0;
    const secs = isSlow ? slowSec : fastSec;
    const buf = isSlow ? slowBuf : fastBuf;
    parts.push(buf);
    for (let i = 0; i < n; i++) {
      timeline.push({
        seq: i + 1,
        startSec: round2(offset),
        endSec: round2(offset + secs[i]),
        pass: turn + 1,
        passType: isSlow ? 'slow' : 'fast',
      });
      offset += secs[i];
    }
    turn++;
  }
  const full = Buffer.concat(parts);
  writeFileSync(join(dir, 'full.mp3'), full);
  const fullSec = Math.round(await durOf(full));
  console.log(`  full.mp3: ${(full.length / 1048576).toFixed(1)}MB, ${fullSec}s（${(fullSec / 60).toFixed(1)}min），${turn} 个 pass，时间轴 ${timeline.length} 点`);

  // 5) 入库：沿用原 item id；旧句（seq<=6）保留 id 仅更新文本/翻译，追加新句
  const existing = await prisma.sentence.findMany({ where: { itemId: art.itemId }, orderBy: { seq: 'asc' } });
  const oldMax = existing.reduce((m, s) => Math.max(m, s.seq), 0);
  await prisma.contentItem.update({
    where: { id: art.itemId },
    data: {
      transcript: art.sentences.map((s) => s.text).join(' '),
      translation: art.sentences.map((s) => s.zh).join('\n'),
      audioUrl: url(art.dir, 'full.mp3'),
      durationSec: fullSec,
      timelineJson: JSON.stringify(timeline),
    },
  });
  await prisma.$transaction(
    art.sentences.map((s, i) =>
      prisma.sentence.upsert({
        where: { itemId_seq: { itemId: art.itemId, seq: i + 1 } },
        update: { text: s.text, translation: s.zh, audioUrl: url(art.dir, `s${pad(i + 1)}.mp3`) },
        create: {
          itemId: art.itemId,
          seq: i + 1,
          text: s.text,
          translation: s.zh,
          audioUrl: url(art.dir, `s${pad(i + 1)}.mp3`),
        },
      }),
    ),
  );
  const after = await prisma.sentence.count({ where: { itemId: art.itemId } });
  console.log(`  DB: item=${art.itemId} durationSec=${fullSec} 句数 ${existing.length}→${after}（原最大 seq=${oldMax}）`);
  return { title: art.title, itemId: art.itemId, n, fullSec, sentences: after };
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
const round2 = (x) => Math.round(x * 100) / 100;

async function main() {
  if (process.argv.includes('--smoke')) {
    const buf = await synth('Hello, this is a smoke test.', '-15%');
    console.log('TTS smoke ok:', buf.length, 'bytes');
    return;
  }
  const prisma = new PrismaClient();
  const results = [];
  try {
    for (const art of ARTICLES) results.push(await buildArticle(art, prisma));
    console.log('\n=== 汇总 ===');
    for (const r of results) console.log(`${r.title}: ${r.n} 句, ${r.fullSec}s (${(r.fullSec / 60).toFixed(1)}min)`);
    console.log(`合计 ${sum(results.map((r) => r.fullSec))}s`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
