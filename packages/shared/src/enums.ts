/**
 * 领域枚举 —— 对应 PRD v0.2 术语表与产品模型（5.1 / 5.2）
 * 前后端共用，禁止在单侧重复定义。
 */

/** 内容分级（PRD 5.1） */
export enum LevelCode {
  L1 = 'L1', // 初阶：小学、初中
  L2 = 'L2', // 中阶：高中（生活、新闻时事）、大学基础
  L3 = 'L3', // 高阶：大学学术应用、托福、雅思
}

/** 内容包定位标签（PRD FR-01 选包步骤） */
export enum PackTag {
  DAILY_LIFE = 'DAILY_LIFE',   // 生活
  NEWS = 'NEWS',               // 新闻
  ACADEMIC = 'ACADEMIC',       // 学术
  EXAM_PREP = 'EXAM_PREP',     // 备考（托福/雅思风格）
}

/** 三阶段类型（PRD 5.2 状态机） */
export enum StageType {
  LISTEN = 'LISTEN',     // 阶段一 · 沉浸听力
  DICTATE = 'DICTATE',   // 阶段二 · 逐句听写
  SPEAK = 'SPEAK',       // 阶段三 · 口语输出
}

/** 阶段状态（PRD 5.2 生命周期） */
export enum StageStatus {
  LOCKED = 'LOCKED',   // 未解锁
  ACTIVE = 'ACTIVE',   // 进行中（任一时刻全计划仅一个）
  DONE = 'DONE',       // 已完成（达成自动条件）
  SKIPPED = 'SKIPPED', // 已提前切换（用户手动跳段，留痕）
}

/** 计划状态 */
export enum PlanStatus {
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
}

/** 材料学习进度（PRD SR-04） */
export enum ItemProgressStatus {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

/** 口语任务类型（PRD FR-05） */
export enum SpeakingType {
  READ = 'READ',     // 跟读（照文本朗读）
  RETELL = 'RETELL', // 复述（无文稿口头复述）
}

/** 听写批改模式（PRD FR-04） */
export enum GradingMode {
  LENIENT = 'LENIENT', // 宽容：忽略大小写与标点（默认）
  STRICT = 'STRICT',   // 严格：判大小写与标点
}
