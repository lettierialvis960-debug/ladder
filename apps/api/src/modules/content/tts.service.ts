import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import mp3Duration from 'mp3-duration';

/** 与 scripts/gen-l1-daily-audio.mjs 保持同一音色，保证自制材料听感一致 */
const VOICE = 'en-US-JennyNeural';
const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

/**
 * B1 自制材料语音合成：复用 Edge 朗读接口生成 MP3（零成本、无需 API Key）。
 * 句切片用 -15% 慢速（听写清晰），整篇用常速（泛听磨耳朵）。
 */
@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

  async synthesize(text: string, rate: string): Promise<Buffer> {
    for (let i = 0; i < 3; i++) {
      try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata(VOICE, FORMAT);
        const { audioStream } = await tts.toStream(text, { rate });
        const chunks: Buffer[] = [];
        for await (const chunk of audioStream) chunks.push(Buffer.from(chunk));
        const buf = Buffer.concat(chunks);
        if (buf.length < 500) throw new Error(`音频过短（${buf.length} 字节）`);
        return buf;
      } catch (e) {
        if (i === 2) {
          this.logger.error(`语音合成失败：${(e as Error).message}`);
          throw new ServiceUnavailableException('语音合成服务暂不可用，请稍后重试');
        }
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    throw new ServiceUnavailableException('语音合成失败');
  }

  /** MP3 实际时长（秒，四舍五入） */
  duration(buffer: Buffer): Promise<number> {
    return new Promise((resolve, reject) => {
      mp3Duration(buffer, (err, d) => (err ? reject(err) : resolve(Math.max(1, Math.round(d ?? 1)))));
    });
  }
}
