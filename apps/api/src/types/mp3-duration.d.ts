declare module 'mp3-duration' {
  /** 读取 MP3 Buffer 时长（秒） */
  function mp3Duration(buffer: Buffer, cb: (err: Error | null, duration?: number) => void): void;
  export default mp3Duration;
}
