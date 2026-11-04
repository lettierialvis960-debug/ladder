import { Injectable, Logger } from '@nestjs/common';

/**
 * 口语评分引擎（决策 D3：第三方供应商未定，先用本地启发式 + 可选文本级评分）。
 *
 * 两条路径：
 *  - 前端提供 transcript（浏览器 Web Speech API ASR 结果）→ 词级 WER 评分
 *  - 前端未提供 transcript → 时长比例启发式评分
 *
 * 这样在所有浏览器都能跑，Chrome/Edge 上有真实词级反馈。
 */
@Injectable()
export class SpeechScoringService {
  private readonly log = new Logger(SpeechScoringService.name);

  /**
   * 跟读评分：传入录音元信息 +（可选）前端 ASR transcript。
   *
   * @param audioDuration 用户录音秒数
   * @param referenceText 参考文本（原句）
   * @param referenceDurationSec 参考音频秒数
   * @param transcript 前端 ASR 识别文本（可选）
   */
  async scoreReadAloud(opts: {
    audioDuration: number;
    referenceText: string;
    referenceDurationSec: number;
    transcript?: string;
  }): Promise<{
    score: number;
    wordsFeedback: Array<{ word: string; ok: boolean }>;
    method: 'wer' | 'duration';
    details?: { wer?: number; durationRatio?: number };
  }> {
    // 路径 A：有 transcript → 词级 WER 评分
    if (opts.transcript && opts.transcript.trim().length > 0) {
      try {
        return this.scoreByWer(opts.referenceText, opts.transcript);
      } catch (e) {
        this.log.warn(`WER 评分失败，回退时长：${(e as Error).message}`);
      }
    }
    // 路径 B：时长比例启发式
    return this.scoreByDuration(opts.audioDuration, opts.referenceDurationSec, opts.referenceText);
  }

  /** 复述评分（无参考逐字稿，按时长 + 自评为基础）。 */
  async scoreRetell(opts: {
    audioDuration: number;
    referenceDurationSec: number;
  }): Promise<{
    score: number;
    wordsFeedback: Array<{ word: string; ok: boolean }>;
    method: 'duration';
  }> {
    const ratio = opts.referenceDurationSec > 0 ? opts.audioDuration / opts.referenceDurationSec : 1;
    // 复述时长 ≥ 参考 30% 给 60 分起步，100%+ 给 90 分
    let score: number;
    if (ratio < 0.3) score = 30 + Math.round(ratio * 100);
    else if (ratio < 1.0) score = 60 + Math.round((ratio - 0.3) * 30 / 0.7);
    else score = 90 + Math.round(Math.min(ratio - 1, 0.5) * 20); // 100%~150% → 90~100
    score = Math.max(0, Math.min(100, score));
    return { score, wordsFeedback: [], method: 'duration' };
  }

  /** === 内部：WER 词级评分 === */
  private scoreByWer(reference: string, transcript: string) {
    const refTokens = this.tokenize(reference);
    const hypTokens = this.tokenize(transcript);
    const { distance, alignment } = this.levenshteinAlignment(refTokens, hypTokens);
    const wer = refTokens.length > 0 ? distance / refTokens.length : 1;
    // WER → 分数：0% WER = 100 分；100%+ WER = 0 分
    const score = Math.max(0, Math.min(100, Math.round((1 - wer) * 100)));
    // 词级反馈：只标记 reference 里的每个词是否被正确匹配
    const wordsFeedback: Array<{ word: string; ok: boolean }> = [];
    for (const a of alignment) {
      if (a.ref !== null) {
        wordsFeedback.push({ word: a.ref, ok: a.hyp !== null && a.ref.toLowerCase() === a.hyp.toLowerCase() });
      }
    }
    return { score, wordsFeedback, method: 'wer' as const, details: { wer: +wer.toFixed(3) } };
  }

  /** === 内部：时长比例评分 === */
  private scoreByDuration(audioDuration: number, refDuration: number, referenceText: string) {
    const ratio = refDuration > 0 ? audioDuration / refDuration : 1;
    // 0.7 ~ 1.3 倍时长 = 100 分；偏离线性扣分；<0.3 或 >2.0 至少给 20 分
    let score: number;
    if (ratio >= 0.7 && ratio <= 1.3) score = 100;
    else if (ratio < 0.7) score = Math.max(20, Math.round(100 - (0.7 - ratio) * 200));
    else score = Math.max(20, Math.round(100 - (ratio - 1.3) * 200));
    const wordsFeedback = this.tokenize(referenceText).map((w) => ({ word: w, ok: true }));
    return { score, wordsFeedback, method: 'duration' as const, details: { durationRatio: +ratio.toFixed(2) } };
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  /** 带对齐的 Levenshtein：返回编辑距离 + 每步的 (ref, hyp) 配对（null = 插入/删除） */
  private levenshteinAlignment(a: string[], b: string[]): {
    distance: number;
    alignment: Array<{ ref: string | null; hyp: string | null }>;
  } {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    // 回溯对齐
    const alignment: Array<{ ref: string | null; hyp: string | null }> = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        alignment.unshift({ ref: a[i - 1], hyp: b[j - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] <= dp[i - 1][j])) {
        alignment.unshift({ ref: null, hyp: b[j - 1] });
        j--;
      } else {
        alignment.unshift({ ref: a[i - 1], hyp: null });
        i--;
      }
    }
    return { distance: dp[m][n], alignment };
  }
}
