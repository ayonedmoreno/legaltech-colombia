import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageEnv } from "./storage-env.js";
import {
  attachmentDisposition,
  StorageObjectNotFoundError,
  type StorageProvider,
} from "./storage.types.js";

/**
 * Timeouts of every request to the storage (decision of 2026-10-01): without them a storage that
 * stops answering would keep a request waiting forever. The SDK keeps its standard retries (3
 * attempts with backoff) for errors, timeouts included, so an operation gives up after at most
 * three timed-out attempts.
 */
export const STORAGE_TIMEOUTS = {
  /** To open the TCP connection. */
  connectionTimeoutMs: 5_000,
  /** Of inactivity on an open connection (no byte sent or received). */
  socketTimeoutMs: 30_000,
  /** Of one whole request, from sending it to its complete answer. */
  requestTimeoutMs: 45_000,
} as const;

export type StorageTimeouts = { [K in keyof typeof STORAGE_TIMEOUTS]: number };

/** The SDK request handler options for these timeouts (a timed-out request is an error). */
export function requestHandlerOptions(timeouts: StorageTimeouts = STORAGE_TIMEOUTS) {
  return {
    connectionTimeout: timeouts.connectionTimeoutMs,
    socketTimeout: timeouts.socketTimeoutMs,
    requestTimeout: timeouts.requestTimeoutMs,
    // Without it the SDK only logs a warning when requestTimeout is exceeded.
    throwOnRequestTimeout: true,
  };
}

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

  /** `timeouts` only for tests; production always uses STORAGE_TIMEOUTS. */
  constructor(env: StorageEnv, options: { timeouts?: StorageTimeouts } = {}) {
    const base: S3ClientConfig = {
      region: env.STORAGE_REGION,
      requestHandler: requestHandlerOptions(options.timeouts),
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

  async getObject(key: string): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) throw new StorageObjectNotFoundError(key);
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof NoSuchKey) throw new StorageObjectNotFoundError(key);
      throw error;
    }
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
