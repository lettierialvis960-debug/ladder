/**
 * 触觉反馈工具（Haptic Feedback）
 * - 优先用 navigator.vibrate（Android / 桌面 Chrome 部分支持）
 * - iOS Safari 不支持 vibrate，但对键盘 / 按钮点击已经有系统级反馈，无需 polyfill
 * - 所有调用都用 try/catch 兜底，确保静默失败
 *
 * 用法：
 *   import { haptic } from '../lib/haptic';
 *   haptic.click();      // 短滴（按钮点击）
 *   haptic.longPress();  // 长震（长按录音开始）
 *   haptic.success();    // 成功模式（三段震）
 */

const isTouchDevice =
  typeof navigator !== 'undefined' &&
  ('ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0);

const canVibrate =
  typeof navigator !== 'undefined' &&
  'vibrate' in navigator &&
  typeof navigator.vibrate === 'function';

function vibrate(pattern: number | number[]) {
  if (!canVibrate || !isTouchDevice) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* iOS 静默失败 */
  }
}

export const haptic = {
  /** 短单击（按钮点击 / tab 切换） */
  click: () => vibrate(15),

  /** 长按开始（录音按钮按住时触发一次） */
  longPress: () => vibrate(25),

  /** 成功三段震：短-停-短-停-长 */
  success: () => vibrate([30, 40, 30, 40, 60]),

  /** 失败震：快速抖动 */
  error: () => vibrate([50, 30, 50]),
};
