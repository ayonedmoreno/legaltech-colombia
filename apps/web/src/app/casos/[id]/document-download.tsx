"use client";

import { useState } from "react";
import { getDocumentDownloadUrl } from "../../../lib/api-client";

/**
 * Downloads a document: asks the API for a short-lived URL (authorized there) and opens it. The
 * storage serves the file as an attachment, so it is never rendered inside the application.
 */
export function DocumentDownload({ caseId, documentId }: { caseId: string; documentId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    setError(null);
    const result = await getDocumentDownloadUrl(caseId, documentId);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    window.location.assign(result.data.url);
  }

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="text-sm underline disabled:opacity-60"
      >
        {pending ? "Preparando…" : "Descargar"}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      ) : null}
    </span>
  );
}
