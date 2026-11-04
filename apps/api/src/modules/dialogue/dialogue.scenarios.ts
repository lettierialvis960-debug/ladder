/**
 * P1 AI 情景对话：场景目录（阶段三解锁后开放）。
 * userLines 与 replies 仅服务于本地桩（模拟语音识别语料 / 回复脚本），
 * 接入真实 ASR/LLM 后这两项保留作回归测试语料，不下发给客户端。
 */
export interface DialogueScenario {
  key: string;
  title: string;
  desc: string;
  scene: string; // 场景设定（英文，供 LLM 系统提示使用）
  opening: string; // AI 开场白（英文）
  userLines: string[]; // 桩 ASR：逐轮模拟的用户发言
  replies: string[]; // 桩 LLM：逐轮 AI 回复
}

export const DIALOGUE_SCENARIOS: DialogueScenario[] = [
  {
    key: 'supermarket',
    title: '在超市买东西',
    desc: '挑选商品、问价、付款',
    scene: 'You are shopping in a small supermarket. You are the shop assistant.',
    opening: 'Hi! Welcome to our shop. What would you like to buy today?',
    userLines: [
      'Hello! I would like to buy some apples and milk, please.',
      'How much are the apples?',
      'Two kilos, please. Can I pay by phone?',
      'Thank you very much. Goodbye!',
    ],
    replies: [
      'Sure! The apples are fresh today. How many kilos would you like?',
      'They are two dollars a kilo. Anything else?',
      'Yes, you can pay by phone at the counter. That is five dollars in all.',
      'You are welcome! Have a nice day. Goodbye!',
    ],
  },
  {
    key: 'restaurant',
    title: '在餐厅点餐',
    desc: '点菜、问价格、结账',
    scene: 'You are at a small restaurant for lunch. You are the waiter.',
    opening: 'Good afternoon! Welcome to Sunny Restaurant. Are you ready to order?',
    userLines: [
      'Yes, I would like a chicken sandwich and a glass of orange juice, please.',
      'How much is it?',
      'No, thank you. That is all.',
      'Thank you. The food is nice!',
    ],
    replies: [
      'Great choice! Would you like some salad with it?',
      'It is eight dollars in total. Would you like anything to drink?',
      'OK. Please wait a few minutes.',
      'Thank you! Please come again. Goodbye!',
    ],
  },
  {
    key: 'directions',
    title: '向路人问路',
    desc: '问路、问远近、道谢',
    scene: 'You are new in town and ask a kind person for directions.',
    opening: 'Hello! You look new here. Can I help you?',
    userLines: [
      'Yes, please. How can I get to the city library?',
      'Is it far from here?',
      'Should I take a bus?',
      'Thank you so much for your help!',
    ],
    replies: [
      'Sure! Go straight along this street and turn left at the bank.',
      'No, it is about ten minutes on foot.',
      'You can, but walking is faster. The library is next to the park.',
      'You are welcome! Have a good day.',
    ],
  },
  {
    key: 'selfintro',
    title: '和新同学打招呼',
    desc: '自我介绍、聊爱好',
    scene: 'You meet a new classmate at school.',
    opening: 'Hi! Nice to meet you. What is your name?',
    userLines: [
      'Hello! My name is Li Ming. Nice to meet you too.',
      'I am twelve years old. I am from China.',
      'I like playing basketball and reading books.',
      'Yes, I like music too. See you tomorrow!',
    ],
    replies: [
      'Nice name! I am Alex. Where are you from?',
      'That is great. What do you like to do after school?',
      'Cool! Do you like music as well?',
      'See you! It was nice talking to you.',
    ],
  },
];
