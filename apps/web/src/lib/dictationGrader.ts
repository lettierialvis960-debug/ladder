import { GradingMode } from '@ladder/shared';

/**
 * FR-04 逐句听写批改：词级比对。
 * 宽容模式（默认）：忽略大小写与标点；严格模式：原样比对。
 * 返回逐词标注结果，供 UI 按 正确(绿)/错误(红)/漏词/多词 渲染（对应 PRD 演示 B）。
 */

export type WordMark =
  | { kind: 'ok'; word: string }
  | { kind: 'wrong'; input: string; expected: string }
  | { kind: 'missing'; expected: string }
  | { kind: 'extra'; input: string };

export interface GradeResult {
  marks: WordMark[];
  correctRate: number;   // 0~1，按原句词数计
  wrongCount: number;
  missingCount: number;
  extraCount: number;
  wrongWords: string[];  // 写入错词本：拼错 + 漏掉的正确词
}

function tokenize(s: string, mode: GradingMode): string[] {
  let t = s;
  if (mode === GradingMode.LENIENT) {
    t = t.toLowerCase().replace(/[.,!?;:'"()\u3002\uff0c\uff01\uff1f]/g, '');
  }
  return t.trim().split(/\s+/).filter(Boolean);
}

export function gradeDictation(reference: string, input: string, mode: GradingMode = GradingMode.LENIENT): GradeResult {
  const ref = tokenize(reference, mode);
  const usr = tokenize(input, mode);

  const marks: WordMark[] = [];
  let wrong = 0, missing = 0, extra = 0;
  const wrongWords: string[] = [];
  const max = Math.max(ref.length, usr.length);

  for (let i = 0; i < max; i++) {
    if (i < ref.length && i < usr.length) {
      if (ref[i] === usr[i]) {
        marks.push({ kind: 'ok', word: usr[i] });
      } else {
        wrong++;
        wrongWords.push(ref[i]);
        marks.push({ kind: 'wrong', input: usr[i], expected: ref[i] });
      }
    } else if (i < ref.length) {
      missing++;
      wrongWords.push(ref[i]);
      marks.push({ kind: 'missing', expected: ref[i] });
    } else {
      extra++;
      marks.push({ kind: 'extra', input: usr[i] });
    }
  }

  return {
    marks,
    correctRate: ref.length === 0 ? 0 : (ref.length - wrong - missing) / ref.length,
    wrongCount: wrong,
    missingCount: missing,
    extraCount: extra,
    wrongWords,
  };
}
