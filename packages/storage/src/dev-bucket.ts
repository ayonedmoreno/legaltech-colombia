import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { StorageEnv } from "./storage-env.js";

/**
 * Creates the configured bucket if it does not exist yet, and says whether it did. Only for the
 * local S3-compatible storage of development and tests (`pnpm storage:init`): in production the
 * bucket, its privacy and its encryption are set up with the provider (P3), and the runtime
 * credentials cannot create buckets.
 */
export async function ensureDevelopmentBucket(env: StorageEnv): Promise<"created" | "exists"> {
  const client = new S3Client({
    region: env.STORAGE_REGION,
    endpoint: env.STORAGE_ENDPOINT,
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    credentials:
      env.STORAGE_ACCESS_KEY_ID && env.STORAGE_SECRET_ACCESS_KEY
        ? { accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY }
        : undefined,
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: env.STORAGE_BUCKET }));
    return "exists";
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: env.STORAGE_BUCKET }));
    return "created";
  }
}
