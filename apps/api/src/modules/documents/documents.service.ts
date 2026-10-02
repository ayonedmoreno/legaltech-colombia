import { randomUUID } from "node:crypto";
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_QUOTA_BYTES,
  type Document,
  type DocumentDownloadResponse,
} from "@legaltech/contracts";
import { HttpError } from "../../common/http-error.js";
import type { StorageProvider } from "@legaltech/storage";
import type { CurrentUserResult, RequestContext } from "../auth/auth.service.js";
import type { CasesRepository } from "../cases/cases.types.js";
import { CONTENT_TYPES, detectFileType } from "./file-type.js";
import { toPublicDocument } from "./documents.mapper.js";
import { can, type DocumentAction } from "./documents.policy.js";
import type { DocumentRecord, DocumentsRepository } from "./documents.types.js";

export interface DocumentsServiceOptions {
  repository: DocumentsRepository;
  cases: CasesRepository;
  storage: StorageProvider;
  /**
   * Tests only: a smaller upload limit, in bytes. The system's limit is DOCUMENT_MAX_BYTES
   * (10 MiB, @legaltech/contracts) and nothing can raise it.
   */
  maxBytes?: number;
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

function quotaExceeded(): HttpError {
  return new HttpError(
    403,
    "FORBIDDEN",
    "Has alcanzado el espacio máximo para tus documentos (100 MB).",
  );
}

function storageUnavailable(): HttpError {
  return new HttpError(
    503,
    "SERVICE_UNAVAILABLE",
    "Servicio no disponible temporalmente. Inténtalo más tarde.",
  );
}

/**
 * The object a download may serve, or null when the document may not be downloaded at all
 * (DATABASE_SPEC.md, "Tratamiento de seguridad del documento"): only a `CLEAN` document, and
 * only the version that went through the treatment — the copy without metadata for JPEG and PNG,
 * the untouched original for PDF (whose metadata cleaning is still undecided). A `CLEAN` image
 * without its copy is refused too: the original may carry identifying metadata.
 */
export function downloadableKey(document: DocumentRecord): string | null {
  if (document.status !== "CLEAN") return null;
  if (document.fileType === "PDF") return document.storageKey;
  return document.sanitizedStorageKey;
}

/**
 * Documents of a case (Phase 3; API_SPEC.md): a user uploads documents to their own `DRAFT`
 * cases, within the upload limit and their space quota, lists them and downloads them through
 * short-lived presigned URLs, only once the worker's security treatment has left them `CLEAN`
 * (see downloadableKey). An ADMIN may ask for a `SCAN_FAILED` document to be treated again. No
 * OCR, versions or deletion yet. Authorization goes through the documents policy (ADR-003), and
 * anything the caller may not see answers 404.
 */
export class DocumentsService {
  private readonly options: DocumentsServiceOptions;
  private readonly clock: () => Date;
  private readonly limit: number;

  constructor(options: DocumentsServiceOptions) {
    const limit = options.maxBytes ?? DOCUMENT_MAX_BYTES;
    if (limit > DOCUMENT_MAX_BYTES) {
      throw new Error("The upload limit cannot exceed DOCUMENT_MAX_BYTES (10 MiB).");
    }
    this.options = options;
    this.limit = limit;
    this.clock = options.clock ?? (() => new Date());
  }

  get maxBytes(): number {
    return this.limit;
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
    if (file.content.length > this.limit) {
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
    // A first look at the quota spares the storage a write that would be refused anyway; the
    // check that counts is repeated under a per-user lock when the row is written.
    const used = await this.options.repository.usedBytes(current.user.id);
    if (used + file.content.length > DOCUMENT_QUOTA_BYTES) throw quotaExceeded();

    // The file goes to storage first; the row, its event and its job are then written together.
    // The key never contains the file name (personal data stays out of the storage layout).
    const id = randomUUID();
    const storageKey = `cases/${caseId}/documents/${id}`;
    try {
      await this.options.storage.putObject({
        key: storageKey,
        body: file.content,
        contentType: CONTENT_TYPES[fileType],
      });
    } catch (error) {
      // A write that timed out may still have been stored: remove it. No row exists.
      log.error({ err: error, storageKey }, "could not store an uploaded document");
      await this.removeOrphan(storageKey, log);
      throw storageUnavailable();
    }

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
        quotaBytes: DOCUMENT_QUOTA_BYTES,
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
    if (created.kind !== "created") {
      await this.removeOrphan(storageKey, log);
      // The case stopped being an owned DRAFT between the check and the write, or a concurrent
      // upload of the same user used up the space meanwhile.
      throw created.kind === "quota_exceeded" ? quotaExceeded() : notFound();
    }
    return toPublicDocument(created.document);
  }

  /**
   * Undoes a stored upload whose row was not written. If the removal fails too, the object stays
   * in storage with no document (never served: nothing points at it) and the failure is logged
   * as `storage.orphan_object` with its key, for a later reconciliation (no garbage collector yet).
   */
  private async removeOrphan(storageKey: string, log: ErrorLogger): Promise<void> {
    try {
      await this.options.storage.deleteObject(storageKey);
    } catch (error) {
      log.error(
        { event: "storage.orphan_object", origin: "upload", storageKey, err: error },
        "an uploaded object could not be removed after a failed upload; reconcile it",
      );
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
    const key = downloadableKey(document);
    if (!key) {
      throw new HttpError(403, "FORBIDDEN", "El documento no está disponible para descarga.");
    }

    const expiresInSeconds = this.options.downloadUrlTtlSeconds;
    const expiresAt = new Date(this.clock().getTime() + expiresInSeconds * 1000);
    const url = await this.options.storage.createDownloadUrl({
      key,
      fileName: document.fileName,
      contentType: CONTENT_TYPES[document.fileType],
      expiresInSeconds,
    });
    return { url, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Whether the caller may ask for reprocessing at all; anyone else gets the same 404 as for an
   * unknown route, before their request is even read (ADR-003).
   */
  assertCanReprocess(current: CurrentUserResult): void {
    if (!can(current.actor, "document:reprocess", { caseOwnerId: current.user.id }).allowed) {
      throw notFound();
    }
  }

  /**
   * `POST /api/admin/documents/:documentId/reprocess` (decision of 2026-10-01): an ADMIN asks for
   * a `SCAN_FAILED` document to be treated again, with a justification (ADR-003: administrative
   * access to another user's data is justified and audited). The request and its
   * `document.reprocess_requested` event are written together with a `document.reprocess` job;
   * the worker then moves the document back to `PENDING_SCAN` only if it is still `SCAN_FAILED`.
   * `INFECTED` and every other status are refused: only a failed treatment can be retried.
   */
  async requestReprocess(
    current: CurrentUserResult,
    documentId: string,
    reason: string,
    context: RequestContext,
  ): Promise<void> {
    this.assertCanReprocess(current);
    const document = await this.options.repository.findDocumentForAdministration(documentId);
    if (!document) throw notFound();
    if (document.status !== "SCAN_FAILED") {
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Solo se puede reprocesar un documento cuyo tratamiento falló.",
      );
    }
    await this.options.repository.requestReprocess({
      documentId: document.id,
      caseId: document.caseId,
      audit: {
        actorUserId: current.user.id,
        actorRole: current.user.role,
        action: "document.reprocess_requested",
        entityType: "Document",
        entityId: document.id,
        caseId: document.caseId,
        // The justification only: never the file name.
        metadata: { reason },
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
      },
    });
  }

  /** Whether the caller may ask for an OCR reprocessing at all; anyone else gets a 404. */
  assertCanReprocessOcr(current: CurrentUserResult): void {
    if (!can(current.actor, "document:reprocess_ocr", { caseOwnerId: current.user.id }).allowed) {
      throw notFound();
    }
  }

  /**
   * `POST /api/admin/documents/:documentId/ocr/reprocess` (decisions OCR-A11 and OCR-A12): an
   * ADMIN asks, with a justification, for a document whose OCR is `FAILED` to be processed again.
   * The request's `document.ocr_reprocess_requested` event and a `document.ocr_reprocess` job are
   * written together; the worker then moves the OCR back to `PENDING` only if it is still `FAILED`.
   * It never reads, returns or exposes the document's content or text.
   */
  async requestOcrReprocess(
    current: CurrentUserResult,
    documentId: string,
    reason: string,
    context: RequestContext,
  ): Promise<void> {
    this.assertCanReprocessOcr(current);
    const document = await this.options.repository.findDocumentForAdministration(documentId);
    if (!document) throw notFound();
    if (document.status !== "CLEAN" || document.ocrStatus !== "FAILED") {
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Solo se puede reprocesar el OCR de un documento cuyo OCR falló.",
      );
    }
    await this.options.repository.requestOcrReprocess({
      documentId: document.id,
      caseId: document.caseId,
      audit: {
        actorUserId: current.user.id,
        actorRole: current.user.role,
        action: "document.ocr_reprocess_requested",
        entityType: "Document",
        entityId: document.id,
        caseId: document.caseId,
        // The justification only: never the file name nor any text.
        metadata: { reason },
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
      },
    });
  }
}
