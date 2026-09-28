import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageEnv } from "../config/storage-env.js";
import { attachmentDisposition, type StorageProvider } from "./storage.types.js";

/**
 * StorageProvider over any S3-compatible service: SeaweedFS in development and CI, the
 * production provider once P3 is decided (only the configuration changes). The bucket is
 * private: objects are only reachable through presigned URLs issued by the API.
 */
export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  /** Signs the download URLs with the endpoint the browser can reach (may differ from ours). */
  private readonly presignClient: S3Client;
  private readonly bucket: string;

  constructor(env: StorageEnv) {
    const base: S3ClientConfig = {
      region: env.STORAGE_REGION,
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
      credentials:
        env.STORAGE_ACCESS_KEY_ID && env.STORAGE_SECRET_ACCESS_KEY
          ? {
              accessKeyId: env.STORAGE_ACCESS_KEY_ID,
              secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
            }
          : undefined,
    };
    this.client = new S3Client({ ...base, endpoint: env.STORAGE_ENDPOINT });
    this.presignClient = new S3Client({
      ...base,
      endpoint: env.STORAGE_PUBLIC_ENDPOINT ?? env.STORAGE_ENDPOINT,
    });
    this.bucket = env.STORAGE_BUCKET;
  }

  async putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.body.length,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async createDownloadUrl(input: {
    key: string;
    fileName: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ResponseContentDisposition: attachmentDisposition(input.fileName),
        ResponseContentType: input.contentType,
      }),
      { expiresIn: input.expiresInSeconds },
    );
  }
}
