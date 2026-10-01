import { DOCUMENT_MAX_BYTES, DOCUMENT_QUOTA_BYTES } from "@legaltech/contracts";
import { MemoryStorageProvider } from "@legaltech/storage";
import { describe, expect, it } from "vitest";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { FakeCasesRepository } from "../cases/cases.repository.fake.js";
import { FakeDocumentsRepository } from "./documents.repository.fake.js";
import { DocumentsService } from "./documents.service.js";

/**
 * The upload limit (one value, 10 MiB), the per-user quota (100 MiB) and what an upload leaves
 * behind when the storage fails (decisions of 2026-10-01; API_SPEC.md).
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const MIB = 1024 * 1024;
const pdf = (size: number) => {
  const body = Buffer.alloc(size, 0x20);
  body.write("%PDF-1.7\n");
  return body;
};

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

async function session(testApp: TestApp, email = "ana@example.com") {
  await testApp.app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD, fullName: "Ana Gómez" },
  });
  const login = await testApp.app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD },
  });
  const sessionRaw = findSetCookie(login.headers["set-cookie"], "__Host-session")!.value;
  const csrfRaw = findSetCookie(login.headers["set-cookie"], "__Host-csrf")!.value;
  const headers = {
    origin: ORIGIN,
    "x-csrf-token": csrfRaw,
    cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": csrfRaw }),
  };
  const created = await testApp.app.inject({
    method: "POST",
    url: "/api/cases",
    headers: { ...headers, "content-type": "application/json" },
    payload: { type: "OTHER" },
  });
  const caseId: string = created.json().case.id;
  const upload = (body: Buffer, targetCase = caseId) =>
    testApp.app.inject({
      method: "POST",
      url: `/api/cases/${targetCase}/documents`,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-file-name": "comparendo.pdf",
      },
      payload: body,
    });
  const newCase = async () =>
    (
      await testApp.app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { ...headers, "content-type": "application/json" },
        payload: { type: "OTHER" },
      })
    ).json().case.id as string;
  return { caseId, upload, newCase };
}

describe("upload limit", () => {
  it("is one value, 10 MiB: exactly the limit is accepted, one byte more is 413", async () => {
    const testApp = await buildTestApp();
    const ana = await session(testApp);

    expect(DOCUMENT_MAX_BYTES).toBe(10 * MIB);
    expect((await ana.upload(pdf(10 * MIB))).statusCode).toBe(201);
    const over = await ana.upload(pdf(10 * MIB + 1));
    expect(over.statusCode).toBe(413);
    expect(over.json().error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("cannot be raised above 10 MiB, only lowered for tests", () => {
    const cases = new FakeCasesRepository();
    const options = {
      repository: new FakeDocumentsRepository(cases),
      cases,
      storage: new MemoryStorageProvider(),
      downloadUrlTtlSeconds: 60,
    };
    expect(new DocumentsService(options).maxBytes).toBe(DOCUMENT_MAX_BYTES);
    expect(new DocumentsService({ ...options, maxBytes: 64 }).maxBytes).toBe(64);
    expect(() => new DocumentsService({ ...options, maxBytes: DOCUMENT_MAX_BYTES + 1 })).toThrow(
      /cannot exceed/,
    );
  });
});

describe("per-user quota", () => {
  it("refuses an upload that would take the user past 100 MiB, storing nothing", async () => {
    const testApp = await buildTestApp();
    const ana = await session(testApp);
    // Ten documents of 10 MiB fill the quota exactly, across the user's cases.
    for (let i = 0; i < 10; i++) {
      const target = i < 5 ? ana.caseId : undefined;
      const caseId = target ?? (i === 5 ? await ana.newCase() : undefined);
      expect((await ana.upload(pdf(10 * MIB), caseId ?? ana.caseId)).statusCode).toBe(201);
    }
    expect(
      await testApp.documentsRepository.usedBytes([...testApp.repository.users.keys()][0]!),
    ).toBe(DOCUMENT_QUOTA_BYTES);
    const objectsBefore = testApp.storage.objects.size;
    const rowsBefore = testApp.documentsRepository.documents.size;
    let writes = 0;
    const putObject = testApp.storage.putObject.bind(testApp.storage);
    testApp.storage.putObject = (input) => {
      writes += 1;
      return putObject(input);
    };

    const refused = await ana.upload(pdf(100));

    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({
      code: "FORBIDDEN",
      message: "Has alcanzado el espacio máximo para tus documentos (100 MB).",
    });
    expect(testApp.storage.objects.size).toBe(objectsBefore);
    expect(testApp.documentsRepository.documents.size).toBe(rowsBefore);
    // Refused before touching the storage: no write to undo.
    expect(writes).toBe(0);
  });

  it("is per user: another user's documents do not count", async () => {
    const testApp = await buildTestApp();
    const ana = await session(testApp, "ana@example.com");
    for (let i = 0; i < 10; i++) await ana.upload(pdf(10 * MIB));
    const luis = await session(testApp, "luis@example.com");

    expect((await luis.upload(pdf(10 * MIB))).statusCode).toBe(201);
  });

  it("refuses at write time when a concurrent upload used the space meanwhile, removing the file", async () => {
    // The first look passes; the check under the lock refuses (another upload got there first).
    class RacingRepository extends FakeDocumentsRepository {
      override async usedBytes(): Promise<number> {
        return 0;
      }
      override async createDocument(): ReturnType<FakeDocumentsRepository["createDocument"]> {
        return { kind: "quota_exceeded" };
      }
    }
    const cases = new FakeCasesRepository();
    const testApp = await buildTestApp({
      casesRepository: cases,
      documentsRepository: new RacingRepository(cases),
    });
    const ana = await session(testApp);

    const refused = await ana.upload(pdf(100));

    expect(refused.statusCode).toBe(403);
    expect(testApp.storage.objects.size).toBe(0);
  });
});

describe("storage failures", () => {
  it("answers 503 when the storage fails, keeping no row and removing a half-written object", async () => {
    // The write reaches the storage but its answer is lost (a timeout): the object exists.
    class TimedOutStorage extends MemoryStorageProvider {
      override async putObject(input: { key: string; body: Buffer; contentType: string }) {
        await super.putObject(input);
        throw Object.assign(new Error("request timed out"), { name: "TimeoutError" });
      }
    }
    const testApp = await buildTestApp({ storage: new TimedOutStorage() });
    const ana = await session(testApp);

    const response = await ana.upload(pdf(100));

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("SERVICE_UNAVAILABLE");
    expect(response.body).not.toContain("timed out");
    expect(testApp.documentsRepository.documents.size).toBe(0);
    expect(testApp.documentsRepository.auditLog).toHaveLength(0);
    expect(testApp.storage.objects.size).toBe(0);
  });

  it("removes the stored file when the database write fails afterwards", async () => {
    class FailingRepository extends FakeDocumentsRepository {
      override async createDocument(): ReturnType<FakeDocumentsRepository["createDocument"]> {
        throw new Error("connection lost");
      }
    }
    const cases = new FakeCasesRepository();
    const testApp = await buildTestApp({
      casesRepository: cases,
      documentsRepository: new FailingRepository(cases),
    });
    const ana = await session(testApp);

    expect((await ana.upload(pdf(100))).statusCode).toBe(500);
    expect(testApp.storage.objects.size).toBe(0);
  });
});

describe("orphan objects", () => {
  it("logs an object stored without an answer whose removal fails too, with its key", async () => {
    // PutObject reached the storage but its answer was lost (a timeout), and the removal fails:
    // the object stays, with no document, and must be findable for a later reconciliation.
    class StoredButLostStorage extends MemoryStorageProvider {
      override async putObject(input: { key: string; body: Buffer; contentType: string }) {
        await super.putObject(input);
        throw Object.assign(new Error("request timed out"), { name: "TimeoutError" });
      }
      override async deleteObject(): Promise<void> {
        throw Object.assign(new Error("request timed out"), { name: "TimeoutError" });
      }
    }
    const cases = new FakeCasesRepository();
    const repository = new FakeDocumentsRepository(cases);
    const storage = new StoredButLostStorage();
    const service = new DocumentsService({ repository, cases, storage, downloadUrlTtlSeconds: 60 });
    const userId = "11111111-1111-4111-8111-111111111111";
    const caseRecord = await cases.createCase({
      userId,
      type: "OTHER",
      audit: (r) => ({
        actorUserId: userId,
        actorRole: "USER",
        action: "case.created",
        entityId: r.id,
        requestId: null,
        ip: null,
        userAgent: null,
      }),
    });
    const current = {
      user: { id: userId, role: "USER" },
      actor: { id: userId, role: "USER", status: "ACTIVE" },
    } as unknown as Parameters<DocumentsService["uploadDocument"]>[0];
    const logged: Array<{ object: Record<string, unknown>; message: string }> = [];
    const log = {
      error: (object: object, message: string) =>
        logged.push({ object: object as Record<string, unknown>, message }),
    };

    const error = await service
      .uploadDocument(
        current,
        caseRecord.id,
        { fileName: "a.pdf", content: Buffer.from("%PDF-1.7\n") },
        { ip: null, userAgent: null, requestId: "r1" },
        log,
      )
      .then(
        () => ({ statusCode: undefined }),
        (e: unknown) => e as { statusCode?: number },
      );

    expect(error.statusCode).toBe(503);
    expect(repository.documents.size).toBe(0);
    const [key] = [...storage.objects.keys()];
    expect(key).toBeDefined();
    expect(logged).toContainEqual({
      object: expect.objectContaining({
        event: "storage.orphan_object",
        origin: "upload",
        storageKey: key,
      }),
      message: expect.stringContaining("reconcile"),
    });
  });
});
