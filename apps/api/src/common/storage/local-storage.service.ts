import { Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, createReadStream, statSync, promises as fsp } from 'fs';
import { join, relative } from 'path';
import { Readable } from 'stream';
import { StorageService } from './storage.interface';

/**
 * 本地文件系统实现
 * —— 所有文件落盘到 {cwd}/uploads/
 * —— 公开 URL 前缀：/uploads/
 * —— 与当前 behavior 完全对齐，作为开发期默认实现
 */
@Injectable()
export class LocalStorageService extends StorageService implements OnModuleInit {
  private readonly root: string;
  private readonly urlPrefix: string;

  constructor() {
    super();
    // 允许通过 env 覆盖根目录（沙箱环境 E 盘不可写时可指定 C 盘路径）
    this.root = process.env.STORAGE_LOCAL_ROOT
      ? join(process.env.STORAGE_LOCAL_ROOT)
      : join(process.cwd(), 'uploads');
    // 允许通过 env 覆盖 URL 前缀（例如本地反向代理场景）
    this.urlPrefix = (process.env.UPLOAD_URL_PREFIX ?? '/uploads').replace(/\/$/, '');
  }

  onModuleInit() {
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true });
    }
  }

  private resolveLocalPath(key: string): string {
    // 防止路径穿越：只允许 root 下的文件
    const cleanKey = key.replace(/^\/+/, '');
    const full = join(this.root, cleanKey);
    const rel = relative(this.root, full);
    if (rel.startsWith('..') || rel.startsWith('\\')) {
      throw new Error(`Illegal storage key: ${key}`);
    }
    return full;
  }

  async putBuffer(key: string, buffer: Buffer): Promise<void> {
    const localPath = this.resolveLocalPath(key);
    const dir = join(localPath, '..');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(localPath, buffer);
  }

  async getBuffer(key: string): Promise<Buffer> {
    const localPath = this.resolveLocalPath(key);
    if (!existsSync(localPath)) {
      throw new Error(`File not found: ${key}`);
    }
    return readFileSync(localPath);
  }

  async getStream(key: string): Promise<Readable> {
    const localPath = this.resolveLocalPath(key);
    if (!existsSync(localPath)) {
      throw new Error(`File not found: ${key}`);
    }
    return createReadStream(localPath);
  }

  async exists(key: string): Promise<boolean> {
    const localPath = this.resolveLocalPath(key);
    return existsSync(localPath);
  }

  async delete(key: string): Promise<void> {
    const localPath = this.resolveLocalPath(key);
    if (existsSync(localPath)) {
      rmSync(localPath);
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    const cleanPrefix = prefix.replace(/^\/+/, '');
    const dir = this.resolveLocalPath(cleanPrefix);
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      rmSync(dir, { recursive: true, force: true });
    } else if (existsSync(dir)) {
      // 是文件的情况（整个 prefix 就是一个文件 key）
      rmSync(dir, { force: true });
    }
  }

  getPublicUrl(key: string): string {
    const cleanKey = key.replace(/^\/+/, '');
    return `${this.urlPrefix}/${cleanKey}`;
  }

  parseKeyFromUrl(url: string): string | null {
    if (!url) return null;
    const prefixWithSlash = this.urlPrefix + '/';
    const idx = url.indexOf(prefixWithSlash);
    if (idx >= 0) {
      return url.substring(idx + prefixWithSlash.length);
    }
    // 兼容旧数据：/uploads/xxx
    if (url.startsWith('/uploads/')) {
      return url.substring('/uploads/'.length);
    }
    return null;
  }
}
