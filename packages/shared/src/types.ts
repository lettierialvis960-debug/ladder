/**
 * 共享 DTO 类型 —— 前后端接口契约。
 * 与 apps/api 的 controller 出入参、apps/web 的 api client 一一对应。
 */
import type {
  LevelCode,
  PackTag,
  PlanStatus,
  SpeakingType,
  StageStatus,
  StageType,
} from './enums';

/* ---------- 内容库（FR-02） ---------- */

export interface LevelDto {
  code: LevelCode;
  name: string;        // 初阶 / 中阶 / 高阶
  audience: string;    // 对应学段说明
  description: string;
}

export interface ContentPackDto {
  id: string;
  levelCode: LevelCode;
  title: string;
  tags: PackTag[];
  itemCount: number;
  /** 包内材料总时长（分钟），用于内容选择时判断体量 */
  durationMin?: number;
  /** 包内句子总数 */
  sentenceCount?: number;
}

export interface ContentItemDto {
  id: string;
  packId: string;
  /** 所属内容包标题（Listen 页面展示 + Media Session metadata.artist） */
  packTitle?: string;
  title: string;
  audioUrl: string;
  durationSec: number;
  /** 文稿/译文可见性由阶段控制（FR-03：阶段一默认盲听） */
  transcript: string;
  translation: string;
  inListeningList: boolean;
  inDictationList: boolean;
  /** P1-2 逐句时间轴（rebuild 脚本生成；官方慢/快交替材料有值，自定义材料无 → 不支持跟随） */
  timeline?: SentenceTimelinePoint[];
  /** 句子总数（我的材料列表展示用） */
  sentenceCount?: number;
}

export interface SentenceDto {
  id: string;
  itemId: string;
  seq: number;
  text: string;
  translation: string;
  audioUrl: string;
}

/** P1-2 逐句高亮跟随：整篇音频中某句的一次出现（慢/快 pass 交替 → 同句多次出现） */
export interface SentenceTimelinePoint {
  seq: number;
  startSec: number;
  /** 该次出现的结束秒（可选；缺失时前端以下一点 startSec 或音频总时长兜底） */
  endSec?: number;
}

/** I2 内容搜索：材料标题命中 + 句子文本/译文命中 */
export interface ContentSearchDto {
  items: {
    id: string;
    title: string;
    packTitle: string;
    sentenceCount: number;
  }[];
  sentences: {
    id: string;
    text: string;
    translation: string;
    item: { id: string; title: string };
  }[];
}

/* ---------- 计划与阶段（FR-01 / FR-06） ---------- */

export interface CreatePlanInput {
  levelCode: LevelCode;
  packId: string;
  stage1Days: number;              // 30 / 45 / 60
  stage2Days?: number;             // 默认 60（D4）
  stage3Days?: number;             // 默认 30（暂定）
}

export interface StageDto {
  id: string;
  type: StageType;
  seq: number;                     // 1 / 2 / 3
  status: StageStatus;
  plannedDays: number;
  startDate: string | null;        // ISO date
  endDate: string | null;
  completionRate: number;          // 0~1
  /** 用户可见的解锁条件解释（FR-06） */
  unlockHint: string | null;
}

export interface PlanDto {
  id: string;
  status: PlanStatus;
  levelCode: LevelCode;
  packId: string;
  /** 内容包标题（服务端反查，含用户自定义包，前端无需再按级别匹配） */
  packTitle?: string;
  createdAt: string;
  stages: StageDto[];
}

/* ---------- G2 每日目标（可在设置页自定义） ---------- */

export interface DailyGoalsDto {
  /** 阶段一：每日有效听力分钟数 */
  listenMin: number;
  /** 阶段二：每日听写篇数 */
  dictationPassages: number;
  /** 阶段三：每日跟读句数 */
  readSentences: number;
}

/* ---------- 今日任务（FR-03/04/05 统一入口） ---------- */

/** SR-03：断签恢复挑战状态 */
export interface RecoveryDto {
  /** NONE=无需挑战；BROKEN=已断签待恢复；RECOVERING=挑战进行中（断签后重新打卡但未达目标天数） */
  state: 'NONE' | 'BROKEN' | 'RECOVERING';
  /** 已连续中断天数（仅 BROKEN 有意义） */
  breakDays: number;
  /** 挑战目标天数（RECOVERY_TARGET_DAYS） */
  targetDays: number;
}

export interface TodayTaskDto {
  date: string;                    // 本地日期 YYYY-MM-DD（SR-02）
  stageType: StageType;
  /** 阶段一：已听/目标（分钟）；阶段二三：已完成/任务量 */
  progress: number;
  goal: number;
  unit: 'minutes' | 'passages' | 'sentences';
  checkedIn: boolean;
  streakDays: number;              // 连续打卡（SR-03，由 checkin 推导）
  recovery: RecoveryDto;           // 断签恢复挑战（SR-03）
}

/* ---------- 学习记录上报 ---------- */

/** P2-2：阶段二听写优先队列 —— 未解决「没听懂」句子（已排除当日已听写），听写页据此前置安排 */
export interface DictationPriorityDto {
  /** 优先句子的 sentenceId（按标记时间倒序） */
  sentenceIds: string[];
  /** 优先句子所属材料的 itemId（去重） */
  itemIds: string[];
}

/** A1 弱项专项训练：聚合「没听懂 + 错词 + 听写低正确率」后的待练句子 */
export interface WeakDrillItemDto {
  id: string;
  text: string;
  translation: string;
  audioUrl: string;
  /** 所属材料标题 */
  itemTitle: string;
  /** 命中原因：没听懂 / 错词 / 听写正确率低 */
  reasons: string[];
  /** 弱项权重（越大越优先） */
  score: number;
  /** 命中错词（无则为空） */
  words: string[];
}

/** A3 学习周报：单日趋势点 */
export interface WeeklyDayDto {
  date: string;
  listenMin: number;
  dictationCount: number;
  dictationAvgRate: number;
  speakingCount: number;
  checkedIn: boolean;
}

/** A3 学习周报：近 7 日趋势 + 累计 + 薄弱词 + 阶段进度 */
export interface WeeklyReportDto {
  startDate: string;
  endDate: string;
  days: WeeklyDayDto[];
  totals: {
    listenMin: number;
    dictationCount: number;
    dictationAvgRate: number;
    speakingCount: number;
    checkedDays: number;
  };
  /** 近 7 天新增错词频次 Top5 */
  weakWords: { word: string; count: number }[];
  stage: { type: string; dayIndex: number; plannedDays: number } | null;
}

/** E1 内容学习进度：单篇材料（听过 / 听写 / 跟读覆盖） */
export interface ItemProgressDto {
  itemId: string;
  title: string;
  sentenceCount: number;
  /** 累计有效听力秒数（SR-01 口径） */
  listenedSec: number;
  /** 已听写过的句子数（去重） */
  dictatedSentences: number;
  /** 已跟读过的句子数（去重，仅 READ） */
  spokenSentences: number;
}

/** E3 阶段自动推进结果 */
export interface AutoAdvanceDto {
  advanced: boolean;
  /** 本次尝试推进的阶段类型（无进行中阶段时为 null） */
  stageType: StageType | null;
  /** 未推进时的条件差距文案 */
  gap: string | null;
}

/** F2 句子收藏夹：单条收藏（附原句与材料标题） */
export interface FavoriteSentenceDto {
  id: string;
  createdAt: string;
  sentence: {
    id: string;
    text: string;
    translation: string;
    audioUrl: string;
    item: { id: string; title: string };
  };
}

/** F3 数据导入恢复结果 */
export interface ImportResultDto {
  checkins: number;
  wrongWords: number;
  favorites: number;
  confusedMarks: number;
  /** 已存在或句子已失效而跳过的条数 */
  skipped: number;
}

/** A2 错词本 SRS：单条错词（含到期信息） */
export interface WrongWordDto {
  id: string;
  word: string;
  /** 连续「记住了」次数（0 = 新词） */
  reviewCount: number;
  /** 下次到期时间（ISO） */
  dueAt: string;
  createdAt: string;
  sentence: { id: string; text: string; translation: string; audioUrl: string; item: { id: string; title: string } };
}

/** A2 错词本 SRS：到期队列与统计 */
export interface WrongWordDueDto {
  /** 已到期（dueAt <= 现在），按到期时间升序 */
  due: WrongWordDto[];
  /** 未到期（学习中） */
  upcoming: WrongWordDto[];
  stats: {
    /** 到期待复习条数 */
    due: number;
    /** 其中已逾期（到期日早于今天）条数 */
    overdue: number;
    /** 学习中（未到期）条数 */
    learning: number;
    /** 已掌握条数 */
    mastered: number;
  };
}

/** C2 成就徽章：单枚徽章 */
export interface AchievementDto {
  key: string;
  title: string;
  description: string;
  /** 当前进度（与 target 同量纲） */
  progress: number;
  target: number;
  unlocked: boolean;
  category: 'streak' | 'listen' | 'dictation' | 'speaking' | 'review' | 'plan';
}

/** C2 成就徽章：全部徽章与解锁数 */
export interface AchievementsDto {
  unlockedCount: number;
  total: number;
  items: AchievementDto[];
}

/** K3 学习动态：事件类型 */
export type ActivityType = 'listen' | 'dictation' | 'review' | 'speaking' | 'checkin';

/** K3 学习动态：单条事件（听力/听写/复习/口语/打卡统一时间线） */
export interface ActivityEventDto {
  type: ActivityType;
  /** 事件标题，如「有效听力 12 分钟」 */
  label: string;
  /** 补充信息（材料名/句子/错词） */
  detail: string;
  /** 本地日期 YYYY-MM-DD */
  date: string;
  /** ISO 时间，用于排序与展示 */
  createdAt: string;
}

/** K3 学习动态：近 N 天事件流 */
export interface ActivityDto {
  startDate: string;
  endDate: string;
  events: ActivityEventDto[];
}

/** SR-01：有效听时长上报（客户端 tracker 已按口径过滤） */
export interface ReportListeningInput {
  itemId: string;
  date: string;                    // YYYY-MM-DD
  effectiveSec: number;
}

/** FR-04：单句听写结果 */
export interface DictationAttemptInput {
  sentenceId: string;
  date: string;
  input: string;
  correctRate: number;             // 0~1
  replayCount: number;
  wrongWords: string[];
}

/** FR-05：口语记录（跟读/复述） */
export interface SpeakingRecordInput {
  type: SpeakingType;
  date: string;
  sentenceId?: string;             // READ 必填
  itemId?: string;                 // RETELL 必填
  audioUrl: string;                // 先走上传接口拿到 URL
  durationSec: number;
  score?: number;                  // 第三方评分（D3），可空=待评分
}

/* ---------- 统计（FR-07） ---------- */

export interface CheckinDayDto {
  date: string;
  stageType: StageType;
  done: boolean;
}

export interface PlanSummaryDto {
  /** 计划完成页三项累计数据（FR-06） */
  totalListenMin: number;
  dictationSentenceCount: number;
  dictationAvgCorrectRate: number;
  speakingRecordCount: number;
}

// ---------- P1-3 分级小测 ----------
export type QuizQuestionType = 'LISTEN_CHOICE' | 'WORD_PHONETIC';

/** 下发给前端的题目（不含正确答案） */
export interface QuizQuestionDto {
  id: string;
  type: QuizQuestionType;
  /** 题干：LISTEN_CHOICE 为提示语；WORD_PHONETIC 为单词 */
  prompt: string;
  /** LISTEN_CHOICE 专用：句子音频 URL */
  audioUrl?: string;
  /** 选项（4 个） */
  options: string[];
}

export interface QuizSessionDto {
  id: string;
  levelCode: string;
  total: number;
  questions: QuizQuestionDto[];
  score?: number;
  passed?: boolean;
  createdAt: string;
}

export interface QuizSubmitInput {
  /** [{ questionId, answer }]，answer 为选项文本 */
  answers: Array<{ questionId: string; answer: string }>;
}

export interface QuizSubmitResultDto {
  sessionId: string;
  score: number;
  total: number;
  passed: boolean;
  /** 每题正误详情 */
  details: Array<{ questionId: string; correct: boolean; answer: string; correctAnswer: string }>;
  suggestion: string;
}

export interface QuizHistoryItemDto {
  id: string;
  levelCode: string;
  total: number;
  score: number | null;
  passed: boolean | null;
  createdAt: string;
}
