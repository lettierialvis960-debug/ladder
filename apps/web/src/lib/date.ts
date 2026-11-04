/**
 * 本地日期 YYYY-MM-DD。
 * SR-02 打卡与 SR-01 计时的口径均为「本地日期」，须与后端 stats.service 的 todayLocal 一致。
 */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
