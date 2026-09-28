import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { loadStorageEnv } from "../config/storage-env.js";

/**
 * `pnpm storage:init`: creates the documents bucket in the local S3-compatible storage
 * (SeaweedFS, `pnpm db:up`) if it does not exist yet. Development and test only: in production
 * the bucket, its privacy and its encryption are set up with the provider (P3), and the API's
 * credentials cannot create buckets.
 */
if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
  throw new Error("storage:init only runs with NODE_ENV=development or test.");
}
const env = loadStorageEnv();
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
  console.log(`bucket ${env.STORAGE_BUCKET} already exists`);
} catch {
  await client.send(new CreateBucketCommand({ Bucket: env.STORAGE_BUCKET }));
  console.log(`bucket ${env.STORAGE_BUCKET} created`);
}
