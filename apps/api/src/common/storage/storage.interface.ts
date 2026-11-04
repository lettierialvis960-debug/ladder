import { Readable } from 'stream';

/**
 * 对象存储抽象基类（非 abstract，可作为 NestJS DI token）。
 * —— 本地开发用 LocalStorageService，生产用 ObjectStorageService (S3 兼容 API)
 * —— 内部 key 不带任何前缀（如 "words/abc.mp3"、"custom/uuid/full.mp3"）
 * —— 公开 URL 由 getPublicUrl(key) 生成
 */
export class StorageService {
  async putBuffer(_key: string, _buffer: Buffer, _contentType?: string): Promise<void> {
    throw new Error('putBuffer must be implemented by subclass');
  }

  async getBuffer(_key: string): Promise<Buffer> {
    throw new Error('getBuffer must be implemented by subclass');
  }

  async getStream(_key: string): Promise<Readable> {
    throw new Error('getStream must be implemented by subclass');
  }

  async exists(_key: string): Promise<boolean> {
    throw new Error('exists must be implemented by subclass');
  }

  async delete(_key: string): Promise<void> {
    throw new Error('delete must be implemented by subclass');
  }

  async deletePrefix(_prefix: string): Promise<void> {
    throw new Error('deletePrefix must be implemented by subclass');
  }

  getPublicUrl(_key: string): string {
    throw new Error('getPublicUrl must be implemented by subclass');
  }

  /**
   * 客户端实际可访问的下载地址。
   * 默认等同于公开 URL（本地 / 公共读桶）；私有桶实现需返回限时预签名 URL。
   * 注意：落库存储的必须是 getPublicUrl() 的稳定地址，不能存预签名 URL（会过期）。
   */
  async getDownloadUrl(key: string): Promise<string> {
    return this.getPublicUrl(key);
  }

  /** 出站响应是否需要把 audioUrl 换成临时地址（私有桶为 true） */
  get rewritesUrls(): boolean {
    return false;
  }

  parseKeyFromUrl(_url: string): string | null {
    throw new Error('parseKeyFromUrl must be implemented by subclass');
  }
}
