import { ensureDevelopmentBucket, loadStorageEnv } from "@legaltech/storage";

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
const result = await ensureDevelopmentBucket(env);
console.log(`bucket ${env.STORAGE_BUCKET} ${result === "created" ? "created" : "already exists"}`);
