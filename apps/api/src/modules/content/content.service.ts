import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.interface';
import { TtsService } from './tts.service';

/** 自定义材料单篇上限：句数过多会让语音合成长时间阻塞请求 */
const MAX_CUSTOM_SENTENCES = 80;
/** 语音合成并发 lane 数（Edge 朗读接口单连接串行较慢） */
const TTS_LANES = 3;

/** 按句末标点/换行切句，保留标点，过滤空串 */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .replace(/([.!?])\s+(?=[A-Z"'"'])/g, '$1\n')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * P1-2：解析整篇音频逐句时间轴（rebuild 脚本写入的 JSON）。
 * 缺失/损坏返回 undefined → 前端降级为不跟随高亮。
 */
function parseTimeline(json: string | null): { seq: number; startSec: number }[] | undefined {
  if (!json) return undefined;
  try {
    const arr: unknown = JSON.parse(json);
    if (!Array.isArray(arr)) return undefined;
    const points = arr.filter(
      (p): p is { seq: number; startSec: number } =>
        !!p && typeof p === 'object' && typeof (p as any).seq === 'number' && typeof (p as any).startSec === 'number',
    );
    return points.length ? points : undefined;
  } catch {
    return undefined;
  }
}

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tts: TtsService,
    private readonly storage: StorageService,
  ) {}

  levels() {
    return this.prisma.level.findMany({ orderBy: { code: 'asc' } });
  }

  /** 官方内容包（B1：附带总时长/句数，便于用户按体量挑选） */
  async packs(levelCode: string) {
    const packs = await this.prisma.contentPack.findMany({
      where: { levelCode, ownerId: null },
      include: {
        items: { select: { durationSec: true, _count: { select: { sentences: true } } } },
      },
      orderBy: { title: 'asc' },
    });
    return packs.map(({ items, tags, ownerId: _ownerId, ...p }) => ({
      ...p,
      tags: tags.split(',').filter(Boolean),
      itemCount: items.length,
      durationMin: Math.round(items.reduce((sum, i) => sum + i.durationSec, 0) / 60),
      sentenceCount: items.reduce((sum, i) => sum + i._count.sentences, 0),
    }));
  }

  items(packId: string, list?: 'listening' | 'dictation') {
    return this.prisma.contentItem.findMany({
      where: {
        packId,
        ...(list === 'listening' ? { inListeningList: true } : {}),
        ...(list === 'dictation' ? { inDictationList: true } : {}),
      },
      orderBy: { title: 'asc' },
      include: { pack: { select: { title: true } } },
    }).then((rows) => rows.map(({ timelineJson, pack, ...r }) => ({
      ...r,
      packTitle: pack.title,
      timeline: parseTimeline(timelineJson),
    })));
  }

  sentences(itemId: string) {
    return this.prisma.sentence.findMany({ where: { itemId }, orderBy: { seq: 'asc' } });
  }

  /**
   * I2 内容搜索：在当前计划包 + 本人自定义材料内检索材料标题与句子文本/译文。
   * list 限定听力/听写清单，避免返回当前页面无法定位的材料。
   */
  async search(userId: string, q: string, list?: 'listening' | 'dictation', packId?: string) {
    const kw = q.trim();
    if (!kw) return { items: [], sentences: [] };

    const listFilter = list === 'listening'
      ? { inListeningList: true }
      : list === 'dictation' ? { inDictationList: true } : {};
    const access = packId
      ? { OR: [{ packId, pack: { ownerId: null } }, { pack: { ownerId: userId } }] }
      : { pack: { OR: [{ ownerId: null }, { ownerId: userId }] } };

    const [items, sentences] = await Promise.all([
      this.prisma.contentItem.findMany({
        where: { ...listFilter, ...access, title: { contains: kw } },
        take: 10,
        orderBy: { title: 'asc' },
        select: { id: true, title: true, pack: { select: { title: true } }, _count: { select: { sentences: true } } },
      }),
      this.prisma.sentence.findMany({
        where: {
          item: { ...listFilter, ...access },
          OR: [{ text: { contains: kw } }, { translation: { contains: kw } }],
        },
        take: 20,
        orderBy: { itemId: 'asc' },
        select: { id: true, text: true, translation: true, item: { select: { id: true, title: true } } },
      }),
    ]);

    return {
      items: items.map(({ _count, pack, ...item }) => ({
        ...item,
        packTitle: pack.title,
        sentenceCount: _count.sentences,
      })),
      sentences,
    };
  }

  /**
   * F1 单词发音：TTS 合成后按小写单词哈希缓存（通过 StorageService 统一存储）。
   * 重复播放直接命中缓存，不再调用 Edge TTS。
   */
  async wordAudio(word: string) {
    const clean = word.trim().replace(/\s+/g, ' ');
    if (!clean || clean.length > 40) throw new BadRequestException('单词不合法');
    const hash = createHash('md5').update(clean.toLowerCase()).digest('hex').slice(0, 10);
    const key = `words/${hash}.mp3`;
    if (!(await this.storage.exists(key))) {
      const buffer = await this.tts.synthesize(clean, '0%');
      await this.storage.putBuffer(key, buffer, 'audio/mpeg');
    }
    return { url: await this.storage.getDownloadUrl(key) };
  }

  /**
   * F1 单词音标：命中缓存直接返回；未命中查询免费词典 API 并缓存。
   * 查询失败（离线/超时/词条缺失）返回 phonetic: null，由前端静默不显示。
   */
  async wordInfo(word: string) {
    const clean = word.trim().replace(/\s+/g, ' ');
    if (!clean || clean.length > 40) throw new BadRequestException('单词不合法');
    const lower = clean.toLowerCase();
    const hash = createHash('md5').update(lower).digest('hex').slice(0, 10);
    const key = `words/meta/${hash}.json`;
    if (await this.storage.exists(key)) {
      const buf = await this.storage.getBuffer(key);
      return JSON.parse(buf.toString('utf8')) as { word: string; phonetic: string | null };
    }
    let phonetic: string | null = null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      phonetic = await this.phoneticFromDictionary(lower, ctrl.signal);
      if (!phonetic) phonetic = await this.phoneticFromWiktionary(lower, ctrl.signal);
    } catch {
      // 网络不可用等：保持 null（不缓存，下次访问会重试）
    } finally {
      clearTimeout(timer);
    }
    const payload = { word: clean, phonetic };
    if (phonetic) {
      await this.storage.putBuffer(key, Buffer.from(JSON.stringify(payload), 'utf8'), 'application/json');
    }
    return payload;
  }

  /** 音标源 1：dictionaryapi.dev（词条覆盖广，含部分变形） */
  private async phoneticFromDictionary(word: string, signal: AbortSignal): Promise<string | null> {
    const res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
      { signal },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { phonetic?: string; phonetics?: { text?: string }[] }[];
    const first = Array.isArray(data) ? data[0] : undefined;
    const raw = first?.phonetic ?? first?.phonetics?.find((p) => p?.text)?.text ?? null;
    return raw ? (raw.startsWith('/') ? raw : `/${raw}/`) : null;
  }

  /** 音标源 2：Wiktionary 英语章节首个 IPA 模板（补齐 went/goes 等不规则变形） */
  private async phoneticFromWiktionary(word: string, signal: AbortSignal): Promise<string | null> {
    const res = await fetch(
      `https://en.wiktionary.org/w/api.php?action=parse&page=${encodeURIComponent(word)}&prop=wikitext&format=json&formatversion=2&redirects=1`,
      { signal, headers: { 'User-Agent': 'ladder-dev/1.0' } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { parse?: { wikitext?: string } };
    const wikitext = json.parse?.wikitext;
    if (typeof wikitext !== 'string') return null;
    const start = wikitext.indexOf('==English==');
    if (start < 0) return null;
    const rest = wikitext.slice(start + 11);
    const nextLang = rest.search(/\n==[A-Z]/);
    const section = nextLang >= 0 ? rest.slice(0, nextLang) : rest;
    const match = section.match(/{{IPA\|en\|(?:\/)?([^|}]+)/);
    const raw = match?.[1]?.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    return raw ? `/${raw}/` : null;
  }

  /**
   * E1 内容学习进度：按材料聚合有效听力时长、听写覆盖句数、跟读覆盖句数。
   * 官方包对所有人可读；个人材料包仅本人可查。
   */
  async progress(userId: string, packId: string) {
    const pack = await this.prisma.contentPack.findFirst({
      where: { id: packId, OR: [{ ownerId: null }, { ownerId: userId }] },
      select: { id: true },
    });
    if (!pack) throw new NotFoundException('内容包不存在');

    const items = await this.prisma.contentItem.findMany({
      where: { packId },
      orderBy: { title: 'asc' },
      select: { id: true, title: true, _count: { select: { sentences: true } } },
    });
    if (items.length === 0) return [];
    const itemIds = items.map((i) => i.id);

    const [listen, dictation, speaking] = await Promise.all([
      this.prisma.listeningSession.groupBy({
        by: ['itemId'],
        where: { userId, itemId: { in: itemIds } },
        _sum: { effectiveSec: true },
      }),
      this.prisma.dictationAttempt.findMany({
        where: { userId, sentence: { itemId: { in: itemIds } } },
        select: { sentenceId: true, sentence: { select: { itemId: true } } },
      }),
      this.prisma.speakingRecord.findMany({
        where: { userId, type: 'READ', sentence: { is: { itemId: { in: itemIds } } } },
        select: { sentenceId: true, sentence: { select: { itemId: true } } },
      }),
    ]);

    const listened = new Map(listen.map((r) => [r.itemId, r._sum.effectiveSec ?? 0]));
    const dictSets = new Map<string, Set<string>>();
    dictation.forEach((a) => {
      const set = dictSets.get(a.sentence.itemId) ?? new Set<string>();
      set.add(a.sentenceId);
      dictSets.set(a.sentence.itemId, set);
    });
    const speakSets = new Map<string, Set<string>>();
    speaking.forEach((r) => {
      const itemId = r.sentence?.itemId;
      if (!itemId || !r.sentenceId) return;
      const set = speakSets.get(itemId) ?? new Set<string>();
      set.add(r.sentenceId);
      speakSets.set(itemId, set);
    });

    return items.map((i) => ({
      itemId: i.id,
      title: i.title,
      sentenceCount: i._count.sentences,
      listenedSec: listened.get(i.id) ?? 0,
      dictatedSentences: dictSets.get(i.id)?.size ?? 0,
      spokenSentences: speakSets.get(i.id)?.size ?? 0,
    }));
  }

  // ---------- B1 自定义材料 ----------

  /** 我的材料（仅本人自定义包内） */
  async myItems(userId: string, list?: 'listening' | 'dictation') {
    const items = await this.prisma.contentItem.findMany({
      where: {
        pack: { ownerId: userId },
        ...(list === 'listening' ? { inListeningList: true } : {}),
        ...(list === 'dictation' ? { inDictationList: true } : {}),
      },
      orderBy: { id: 'desc' },
      include: { _count: { select: { sentences: true } } },
    });
    return items.map(({ _count, timelineJson, ...item }) => ({
      ...item,
      timeline: parseTimeline(timelineJson),
      sentenceCount: _count.sentences,
    }));
  }

  /**
   * B1 导入自定义材料：粘贴英文文本 → 逐句 TTS（慢速）+ 整篇 TTS（常速）→ 入库到个人材料包。
   * 中文翻译按行对应句序（行数不匹配则忽略）。
   * P2-1：音频文件通过 StorageService 统一存储（本地 uploads/custom/ 或 S3 兼容桶内）。
   */
  async importCustom(userId: string, dto: { title?: string; text: string; translation?: string }) {
    const sentences = splitSentences(dto.text);
    if (sentences.length === 0) throw new BadRequestException('未识别到英文句子，请检查文本');
    if (sentences.length > MAX_CUSTOM_SENTENCES) {
      throw new BadRequestException(`单篇最多 ${MAX_CUSTOM_SENTENCES} 句，请拆分成多篇导入`);
    }

    const zhLines = (dto.translation ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    const zh = zhLines.length === sentences.length ? zhLines : sentences.map(() => '');

    const dirName = randomUUID();
    const keyPrefix = `custom/${dirName}/`;

    const assets: { seq: number; text: string; translation: string; audioUrl: string }[] = [];
    const fullText = sentences.join(' ');

    try {
      // 逐句合成（lane 并发），句音频 -15% 慢速
      const queue = sentences.map((text, i) => ({ seq: i + 1, text, file: `s${String(i + 1).padStart(2, '0')}.mp3` }));
      const laneWork = async (lane: number) => {
        for (const t of queue.filter((_, idx) => idx % TTS_LANES === lane)) {
          const buf = await this.tts.synthesize(t.text, '-15%');
          const key = `${keyPrefix}${t.file}`;
          await this.storage.putBuffer(key, buf, 'audio/mpeg');
          assets.push({
            seq: t.seq,
            text: t.text,
            translation: zh[t.seq - 1] ?? '',
            audioUrl: this.storage.getPublicUrl(key),
          });
        }
      };
      await Promise.all(Array.from({ length: Math.min(TTS_LANES, queue.length) }, (_, i) => laneWork(i)));

      // 整篇合成（常速）
      const fullBuf = await this.tts.synthesize(fullText, '0%');
      const fullKey = `${keyPrefix}full.mp3`;
      await this.storage.putBuffer(fullKey, fullBuf, 'audio/mpeg');
      const fullDuration = await this.tts.duration(fullBuf);
      assets.sort((a, b) => a.seq - b.seq);

      const plan = await this.prisma.plan.findFirst({ where: { userId, status: 'ACTIVE' } });
      let pack = await this.prisma.contentPack.findFirst({ where: { ownerId: userId } });
      if (!pack) {
        pack = await this.prisma.contentPack.create({
          data: { ownerId: userId, levelCode: plan?.levelCode ?? 'L1', title: '我的材料', tags: 'CUSTOM' },
        });
      }

      const title = dto.title?.trim() || `${sentences[0].slice(0, 24)}…`;
      const item = await this.prisma.contentItem.create({
        data: {
          packId: pack.id,
          title,
          audioUrl: this.storage.getPublicUrl(fullKey),
          durationSec: fullDuration,
          transcript: fullText,
          translation: zh.filter(Boolean).join('\n'),
          sentences: { create: assets },
        },
        include: { _count: { select: { sentences: true } } },
      });
      const { _count, ...rest } = item;
      return { ...rest, sentenceCount: _count.sentences };
    } catch (e) {
      // 失败回滚已生成的音频
      await this.storage.deletePrefix(keyPrefix);
      throw e;
    }
  }

  /** B1 删除自定义材料（连带本人学习记录，避免外键阻塞） */
  async deleteCustom(userId: string, itemId: string) {
    const item = await this.prisma.contentItem.findFirst({
      where: { id: itemId, pack: { ownerId: userId } },
      include: { sentences: { select: { id: true } } },
    });
    if (!item) throw new NotFoundException('材料不存在');
    const sentenceIds = item.sentences.map((s) => s.id);

    await this.prisma.$transaction([
      this.prisma.speakingRecord.deleteMany({
        where: { userId, OR: [{ sentenceId: { in: sentenceIds } }, { itemId }] },
      }),
      this.prisma.dictationAttempt.deleteMany({ where: { userId, sentenceId: { in: sentenceIds } } }),
      this.prisma.wrongWord.deleteMany({ where: { userId, sentenceId: { in: sentenceIds } } }),
      this.prisma.confusedMark.deleteMany({ where: { userId, sentenceId: { in: sentenceIds } } }),
      this.prisma.listeningSession.deleteMany({ where: { userId, itemId } }),
      this.prisma.sentence.deleteMany({ where: { itemId } }),
      this.prisma.contentItem.delete({ where: { id: itemId } }),
    ]);

    // P2-1：从 audioUrl 反推 storage key prefix 并批量删除
    const key = this.storage.parseKeyFromUrl(item.audioUrl);
    if (key) {
      // key 形如 custom/{uuid}/full.mp3 → prefix = custom/{uuid}/
      const slashIdx = key.lastIndexOf('/');
      const prefix = slashIdx >= 0 ? key.substring(0, slashIdx + 1) : key;
      await this.storage.deletePrefix(prefix);
    }
    return { ok: true };
  }
}
