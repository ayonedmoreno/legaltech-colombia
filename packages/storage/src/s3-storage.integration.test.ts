import { randomUUID } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { S3StorageProvider } from "./s3-storage.js";
import { StorageObjectNotFoundError } from "./storage.types.js";

/**
 * S3StorageProvider against a real S3-compatible service (SeaweedFS in development and CI).
 * Opt-in: runs only when INTEGRATION_S3_ENDPOINT is set. Each run uses its own bucket.
 */
const endpoint = process.env.INTEGRATION_S3_ENDPOINT;
const accessKeyId = process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "";
const secretAccessKey = process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "";

describe.skipIf(!endpoint)("S3StorageProvider (S3-compatible integration)", () => {
  const bucket = `it-${randomUUID()}`;
  let storage: S3StorageProvider;

  beforeAll(async () => {
    const admin = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    storage = new S3StorageProvider({
      STORAGE_BUCKET: bucket,
      STORAGE_REGION: "us-east-1",
      STORAGE_ENDPOINT: endpoint,
      STORAGE_PUBLIC_ENDPOINT: undefined,
      STORAGE_FORCE_PATH_STYLE: true,
      STORAGE_ACCESS_KEY_ID: accessKeyId,
      STORAGE_SECRET_ACCESS_KEY: secretAccessKey,
    });
  });

  const PDF = Buffer.from("%PDF-1.7\nprueba de integración\n%%EOF\n");

  it("stores an object and serves it through a presigned URL, as a named attachment", async () => {
    const key = `cases/${randomUUID()}/documents/${randomUUID()}`;
    await storage.putObject({ key, body: PDF, contentType: "application/pdf" });

    const url = await storage.createDownloadUrl({
      key,
      fileName: "Resolución.pdf",
      contentType: "application/pdf",
      expiresInSeconds: 60,
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(PDF)).toBe(true);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("content-disposition")).toContain("Resoluci%C3%B3n.pdf");
  });

  it("keeps the bucket private: the object cannot be read without a valid signature", async () => {
    const key = `cases/${randomUUID()}/documents/${randomUUID()}`;
    await storage.putObject({ key, body: PDF, contentType: "application/pdf" });
    const url = new URL(
      await storage.createDownloadUrl({
        key,
        fileName: "a.pdf",
        contentType: "application/pdf",
        expiresInSeconds: 60,
      }),
    );

    const unsigned = await fetch(`${url.origin}${url.pathname}`);
    expect(unsigned.status).toBe(403);
    url.searchParams.set("X-Amz-Signature", "0".repeat(64));
    expect((await fetch(url)).status).toBe(403);
  });

  it("stops serving the object once the URL expires", async () => {
    const key = `cases/${randomUUID()}/documents/${randomUUID()}`;
    await storage.putObject({ key, body: PDF, contentType: "application/pdf" });
    const url = await storage.createDownloadUrl({
      key,
      fileName: "a.pdf",
      contentType: "application/pdf",
      expiresInSeconds: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await fetch(url)).status).toBe(403);
  });

  it("reads back the exact bytes of an object, and reports a missing one", async () => {
    const key = `cases/${randomUUID()}/documents/${randomUUID()}`;
    await storage.putObject({ key, body: PDF, contentType: "application/pdf" });

    expect((await storage.getObject(key)).equals(PDF)).toBe(true);
    await expect(storage.getObject(`${key}.missing`)).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
  });

  it("deletes an object (the undo of a failed upload)", async () => {
    const key = `cases/${randomUUID()}/documents/${randomUUID()}`;
    await storage.putObject({ key, body: PDF, contentType: "application/pdf" });
    await storage.deleteObject(key);
    const url = await storage.createDownloadUrl({
      key,
      fileName: "a.pdf",
      contentType: "application/pdf",
      expiresInSeconds: 60,
    });
    expect((await fetch(url)).status).toBe(404);
  });
});
