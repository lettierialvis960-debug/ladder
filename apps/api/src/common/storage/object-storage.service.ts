import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { StorageService } from './storage.interface';

/**
 * S3 兼容对象存储实现
 * —— 覆盖 AWS S3 / 腾讯云 COS / 阿里云 OSS / MinIO / 七牛云 等
 * —— 全部通过 S3Client + 兼容 endpoint 工作
 *
 * 环境变量（.env）：
 *   STORAGE_BACKEND=s3                    ← 切换到此实现
 *   S3_ENDPOINT=https://cos.ap-guangzhou.myqcloud.com
 *   S3_REGION=ap-guangzhou
 *   S3_ACCESS_KEY=xxxxx
 *   S3_SECRET_KEY=xxxxx
 *   S3_BUCKET=ladder-audio
 *   S3_FORCE_PATH_STYLE=true              ← MinIO/自建存储需要
 *   S3_PUBLIC_URL=https://cdn.example.com  ← 可选 CDN 前缀；不填则拼 endpoint
 *   S3_KEY_PREFIX=uploads/                 ← 可选 key 前缀（bucket 里的目录）
 *   STORAGE_PRIVATE=true                   ← 私有桶：读取时下发预签名 URL（不依赖公共读/CDN）
 *   S3_SIGNED_URL_TTL=3600                 ← 预签名有效期（秒），默认 1 小时
 */
@Injectable()
export class ObjectStorageService extends StorageService implements OnModuleInit {
  private readonly logger = new Logger('ObjectStorage');
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;
  private readonly keyPrefix: string;
  private readonly isPrivate: boolean;
  private readonly signedUrlTtl: number;

  constructor() {
    super();
    const endpoint = process.env.S3_ENDPOINT;
    const region = process.env.S3_REGION ?? 'auto';
    const accessKey = process.env.S3_ACCESS_KEY;
    const secretKey = process.env.S3_SECRET_KEY;
    const bucket = process.env.S3_BUCKET;
    const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';
    const publicUrl = process.env.S3_PUBLIC_URL;
    const keyPrefix = (process.env.S3_KEY_PREFIX ?? 'uploads/').replace(/\/$/, '') + '/';

    if (!endpoint || !accessKey || !secretKey || !bucket) {
      throw new Error(
        'ObjectStorageService requires S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY / S3_BUCKET in .env',
      );
    }

    this.client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle,
    });

    this.bucket = bucket;
    this.keyPrefix = keyPrefix;
    this.isPrivate = (process.env.STORAGE_PRIVATE ?? 'false').toLowerCase() === 'true';
    this.signedUrlTtl = Math.max(60, Number(process.env.S3_SIGNED_URL_TTL ?? 3600) || 3600);

    if (publicUrl) {
      this.publicUrl = publicUrl.replace(/\/$/, '');
    } else {
      // 用 endpoint + bucket 拼出公开地址（非 forcePathStyle 默认 bucket.endpoint 形式）
      const clean = endpoint.replace(/\/$/, '');
      this.publicUrl = forcePathStyle ? `${clean}/${bucket}` : `https://${bucket}.${clean.replace(/^https?:\/\//, '')}`;
    }
  }

  private fullKey(key: string): string {
    return this.keyPrefix + key.replace(/^\/+/, '');
  }

  onModuleInit() {
    this.logger.log(`ObjectStorage connected → ${this.bucket} @ ${this.publicUrl}`);
  }

  async putBuffer(key: string, buffer: Buffer, contentType?: string): Promise<void> {
    const params = {
      Bucket: this.bucket,
      Key: this.fullKey(key),
      Body: buffer,
      ContentType: contentType ?? 'application/octet-stream',
      // bucket 若已设 public-read 则无需额外 ACL；否则需要通过 bucket policy
    };
    await this.client.send(new PutObjectCommand(params));
  }

  async getBuffer(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as ReadableStream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async getStream(key: string): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
    );
    return res.Body as Readable;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
    );
  }

  async deletePrefix(prefix: string): Promise<void> {
    const fullPrefix = this.fullKey(prefix);
    // 列出所有前缀匹配的 object 然后批量删（最多 1000 个一批；我们单个目录远不到这个数）
    let continuationToken: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        }),
      );
      const objects = list.Contents?.filter(o => o.Key !== undefined).map(o => ({ Key: o.Key! })) ?? [];
      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects } }),
        );
      }
      continuationToken = list.NextContinuationToken;
    } while (continuationToken);
  }

  getPublicUrl(key: string): string {
    const cleanKey = key.replace(/^\/+/, '');
    return `${this.publicUrl}/${this.keyPrefix.replace(/\/$/, '')}/${cleanKey}`;
  }

  get rewritesUrls(): boolean {
    return this.isPrivate;
  }

  /**
   * 下发客户端实际可用的地址。
   * 私有桶：返回限时预签名 URL；公共读/CDN：直接返回公开 URL。
   * 预签名签名时间按 10 分钟窗口取整，保证同一窗口内 URL 稳定（前端/PWA 缓存可命中）。
   */
  async getDownloadUrl(key: string): Promise<string> {
    if (!this.isPrivate) return this.getPublicUrl(key);

    const objectKey = `${this.keyPrefix.replace(/\/$/, '')}/${key.replace(/^\/+/, '')}`;
    const windowMs = 10 * 60 * 1000;
    const signingDate = new Date(Math.floor(Date.now() / windowMs) * windowMs);

    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      { expiresIn: this.signedUrlTtl, signingDate },
    );
  }

  parseKeyFromUrl(url: string): string | null {
    if (!url) return null;
    const clean = url.split('?')[0]; // 预签名 URL 带 query，解析时剥离
    // 尝试 publicUrl 前缀匹配
    if (this.publicUrl) {
      const prefix = this.publicUrl + '/' + this.keyPrefix;
      const idx = clean.indexOf(prefix);
      if (idx >= 0) {
        return clean.substring(idx + prefix.length);
      }
      // 也匹配不带 keyPrefix 的（旧数据迁移场景）
      const idx2 = clean.indexOf(this.publicUrl + '/');
      if (idx2 >= 0) {
        return clean.substring(idx2 + this.publicUrl.length + 1);
      }
    }
    // 本地 /uploads/ 格式也兼容（从本地存储迁移来的数据）
    if (clean.startsWith('/uploads/')) {
      return clean.substring('/uploads/'.length);
    }
    return null;
  }
}
