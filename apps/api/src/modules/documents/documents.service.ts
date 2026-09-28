import { randomUUID } from "node:crypto";
import type { Document, DocumentDownloadResponse } from "@legaltech/contracts";
import { HttpError } from "../../common/http-error.js";
import type { StorageProvider } from "../../storage/storage.types.js";
import type { CurrentUserResult, RequestContext } from "../auth/auth.service.js";
import type { CasesRepository } from "../cases/cases.types.js";
import { CONTENT_TYPES, detectFileType } from "./file-type.js";
import { toPublicDocument } from "./documents.mapper.js";
import { can, type DocumentAction } from "./documents.policy.js";
import type { DocumentsRepository } from "./documents.types.js";

export interface DocumentsServiceOptions {
  repository: DocumentsRepository;
  cases: CasesRepository;
  storage: StorageProvider;
  /** Upper bound of an upload, in bytes (DOCUMENT_MAX_BYTES; provisional technical value). */
  maxBytes: number;
  /** Lifetime of a download URL (DOCUMENT_DOWNLOAD_URL_TTL_SECONDS). */
  downloadUrlTtlSeconds: number;
  clock?: () => Date;
}

/** The part of a logger the service needs (Fastify's request logger satisfies it). */
export interface ErrorLogger {
  error(object: object, message: string): void;
}

function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Recurso no encontrado.");
}

/**
 * Documents of a case, first Phase 3 slice (API_SPEC.md): a user uploads documents to their own
 * `DRAFT` cases, lists them and downloads them through short-lived presigned URLs. No OCR,
 * antivirus, metadata cleaning, versions or deletion yet. Authorization goes through the
 * documents policy (ADR-003), and anything the caller may not see answers 404.
 */
export class DocumentsService {
  private readonly options: DocumentsServiceOptions;
  private readonly clock: () => Date;

  constructor(options: DocumentsServiceOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
  }

  get maxBytes(): number {
    return this.options.maxBytes;
  }

  /** The caller's own case, or 404: checked before anything else is done or revealed. */
  private async ownCase(current: CurrentUserResult, caseId: string, action: DocumentAction) {
    if (!can(current.actor, action, { caseOwnerId: current.user.id }).allowed) throw notFound();
    const found = await this.options.cases.findOwnCase(caseId, current.user.id);
    if (!found || !can(current.actor, action, { caseOwnerId: found.case.userId }).allowed) {
      throw notFound();
    }
    return found.case;
  }

  async uploadDocument(
    current: CurrentUserResult,
    caseId: string,
    file: { fileName: string; content: Buffer },
    context: RequestContext,
    log: ErrorLogger,
  ): Promise<Document> {
    const owned = await this.ownCase(current, caseId, "document:upload");
    if (owned.status !== "DRAFT") {
      throw new HttpError(
        403,
        "FORBIDDEN",
        "No se pueden subir documentos a este caso en su estado actual.",
      );
    }
    if (file.content.length === 0) {
      throw new HttpError(400, "VALIDATION_ERROR", "El archivo está vacío.");
    }
    if (file.content.length > this.options.maxBytes) {
      throw new HttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        "La solicitud supera el tamaño máximo permitido.",
      );
    }
    const fileType = detectFileType(file.content);
    if (!fileType) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "Tipo de archivo no permitido. Solo se admiten PDF, JPEG o PNG.",
      );
    }

    // The file goes to storage first; the row and its event are then written together. The
    // key never contains the file name (personal data stays out of the storage layout).
    const id = randomUUID();
    const storageKey = `cases/${caseId}/documents/${id}`;
    await this.options.storage.putObject({
      key: storageKey,
      body: file.content,
      contentType: CONTENT_TYPES[fileType],
    });

    let created;
    try {
      created = await this.options.repository.createDocument({
        id,
        caseId,
        userId: current.user.id,
        fileName: file.fileName,
        fileType,
        storageKey,
        fileSize: file.content.length,
        audit: (record) => ({
          actorUserId: current.user.id,
          actorRole: current.user.role,
          action: "document.uploaded",
          entityType: "Document",
          entityId: record.id,
          // Never the file name: it may contain personal data.
          newValue: { fileType: record.fileType, fileSize: record.fileSize, status: record.status },
          requestId: context.requestId,
          ip: context.ip,
          userAgent: context.userAgent,
        }),
      });
    } catch (error) {
      await this.removeOrphan(storageKey, log);
      throw error;
    }
    if (!created) {
      // The case stopped being an owned DRAFT between the check and the write.
      await this.removeOrphan(storageKey, log);
      throw notFound();
    }
    return toPublicDocument(created);
  }

  /** Undoes a stored upload whose row was not written; a failure leaves an unreachable object. */
  private async removeOrphan(storageKey: string, log: ErrorLogger): Promise<void> {
    try {
      await this.options.storage.deleteObject(storageKey);
    } catch (error) {
      log.error({ err: error, storageKey }, "could not remove the object of a failed upload");
    }
  }

  async listDocuments(current: CurrentUserResult, caseId: string): Promise<Document[]> {
    await this.ownCase(current, caseId, "document:list");
    const documents = await this.options.repository.listOwnCaseDocuments(caseId, current.user.id);
    return documents.map(toPublicDocument);
  }

  async createDownloadUrl(
    current: CurrentUserResult,
    caseId: string,
    documentId: string,
  ): Promise<DocumentDownloadResponse> {
    await this.ownCase(current, caseId, "document:download");
    const document = await this.options.repository.findOwnDocument(
      documentId,
      caseId,
      current.user.id,
    );
    if (!document) throw notFound();

    const expiresInSeconds = this.options.downloadUrlTtlSeconds;
    const expiresAt = new Date(this.clock().getTime() + expiresInSeconds * 1000);
    const url = await this.options.storage.createDownloadUrl({
      key: document.storageKey,
      fileName: document.fileName,
      contentType: CONTENT_TYPES[document.fileType],
      expiresInSeconds,
    });
    return { url, expiresAt: expiresAt.toISOString() };
  }
}
