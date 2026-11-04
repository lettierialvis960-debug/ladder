/**
 * 共享规则常量 —— 对应 PRD v0.2 第 7 节共享规则（SR-01~05）与 FR-01/FR-06 暂定值。
 * 前后端唯一事实源；PRD 中标注「假设·待确认」的数值集中于此，确认后只改这里。
 */

/* ---------- SR-01 · 有效听时长 ---------- */
/** 每日听力目标（分钟）—— 方法论“每天 1 小时” */
export const DAILY_LISTEN_GOAL_MIN = 60;
/** 切后台/静音容忍时长（秒），超过即停止累计 */
export const BACKGROUND_TOLERANCE_SEC = 10;
/** 单日有效听时长累计上限（分钟），超出不计数（防刷量） */
export const DAILY_LISTEN_CAP_MIN = 180;

/* ---------- SR-02 · 每日任务与打卡 ---------- */
/** 打卡为系统自动触发；以下常量定义各阶段每日核心任务量（暂定值） */
export const DAILY_DICTATION_PASSAGES = 1;   // 阶段二：每日听写篇数
export const DAILY_READ_SENTENCES = 10;      // 阶段三：每日跟读句数
export const DAILY_RETELL_PASSAGES = 1;      // 阶段三：每日复述段数

/* ---------- FR-01 · 阶段时长默认值（天） ---------- */
/** 阶段一可选时长：对应方法论“1 到 2 个月” */
export const STAGE1_DAY_OPTIONS = [30, 45, 60] as const;
/** 阶段二可选时长：默认 60（决策 D4：听写约 2 个月后进入说） */
export const STAGE2_DAY_OPTIONS = [30, 60, 90] as const;
export const STAGE2_DEFAULT_DAYS = 60;
/** 阶段三默认时长（暂定值，需求方未给） */
export const STAGE3_DEFAULT_DAYS = 30;

/* ---------- SR-03 · 断签恢复挑战 ---------- */
/** 恢复挑战目标：断签后连续打卡 N 天视为完成挑战（暂定值） */
export const RECOVERY_TARGET_DAYS = 3;

/* ---------- FR-06 · 阶段推进条件 ---------- */
/** 阶段一 → 阶段二：近 7 天中最少打卡天数 */
export const UNLOCK_MIN_CHECKINS_IN_LAST_7 = 5;
/** 阶段二/三 → 下一阶段：累计完成率阈值 */
export const STAGE_COMPLETION_THRESHOLD = 0.8;

/* ---------- FR-04 · 听写辅助 ---------- */
/** 连续回听超过此次数触发“太难了？”反馈入口（暂定值） */
export const REPLAY_HINT_THRESHOLD = 10;

/* ---------- 内容供给 ---------- */
/** 每级别首发内容包数量下限（暂定值） */
export const MIN_PACKS_PER_LEVEL = 3;
/** 句音频建议长度范围（秒），超长由内容编辑二次切分（暂定值） */
export const SENTENCE_AUDIO_MIN_SEC = 3;
export const SENTENCE_AUDIO_MAX_SEC = 15;
