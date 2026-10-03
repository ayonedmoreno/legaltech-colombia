"use client";

import type { DocumentOcrPage, DocumentOcrStatus } from "@legaltech/contracts";
import { useState } from "react";
import { getDocumentOcr } from "../../../lib/api-client";
import { DOCUMENT_OCR_STATUS_LABELS } from "../../../lib/case-labels";
import { OcrText } from "./ocr-text";

/**
 * The OCR state of a document and, when it is COMPLETED, its text on demand (GET .../ocr, which
 * only the owner may read). Read only: no correction or edition (decision OCR-A3).
 */
export function DocumentOcr({
  caseId,
  documentId,
  ocrStatus,
}: {
  caseId: string;
  documentId: string;
  ocrStatus: DocumentOcrStatus;
}) {
  const [pages, setPages] = useState<DocumentOcrPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onShow() {
    setPending(true);
    setError(null);
    const result = await getDocumentOcr(caseId, documentId);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPages(result.data.pages);
  }

  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="text-slate-600">{DOCUMENT_OCR_STATUS_LABELS[ocrStatus]}</span>
      {ocrStatus === "COMPLETED" && pages === null ? (
        <button
          type="button"
          onClick={onShow}
          disabled={pending}
          className="self-start underline disabled:opacity-60"
        >
          {pending ? "Cargando…" : "Ver texto"}
        </button>
      ) : null}
      {error ? (
        <span role="alert" className="text-red-700">
          {error}
        </span>
      ) : null}
      {pages !== null ? <OcrText pages={pages} /> : null}
    </div>
  );
}
