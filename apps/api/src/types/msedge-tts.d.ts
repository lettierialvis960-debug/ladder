/**
 * msedge-tts 官方未提供类型声明（仅 Node 侧使用）。
 * 这里按实际调用的最小面声明，避免 any 扩散。
 */
declare module 'msedge-tts' {
  export class MsEdgeTTS {
    setMetadata(voiceName: string, outputFormat: string): Promise<void>;
    toStream(text: string, options?: { rate?: string }): Promise<{ audioStream: AsyncIterable<Buffer> }>;
  }
  export const OUTPUT_FORMAT: {
    AUDIO_24KHZ_48KBITRATE_MONO_MP3: string;
    [key: string]: string;
  };
}
