import type { StorageProvider } from "./storage.types.js";

/** In-memory StorageProvider for tests. The S3 implementation has its own integration test. */
export class MemoryStorageProvider implements StorageProvider {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly downloadUrls: Array<{ key: string; fileName: string; expiresInSeconds: number }> = [];

  async putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
    this.objects.set(input.key, { body: input.body, contentType: input.contentType });
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async createDownloadUrl(input: {
    key: string;
    fileName: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string> {
    this.downloadUrls.push(input);
    return `https://storage.test/${input.key}?expires=${input.expiresInSeconds}`;
  }
}
