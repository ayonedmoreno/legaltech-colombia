"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { uploadDocument } from "../../../lib/api-client";
import { DOCUMENT_MAX_BYTES, formatFileSize } from "../../../lib/case-labels";

/**
 * Upload of a document to the user's own DRAFT case (PROJECT_SPEC.md s.9 step 4: PDF, JPG,
 * PNG). The browser checks the size only to spare a useless upload; the API checks everything.
 */
export function DocumentUpload({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Elige un archivo.");
      return;
    }
    if (file.size > DOCUMENT_MAX_BYTES) {
      setError(`El archivo supera el tamaño máximo (${formatFileSize(DOCUMENT_MAX_BYTES)}).`);
      return;
    }
    setPending(true);
    setError(null);
    const result = await uploadDocument(caseId, { content: file, name: file.name });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    form.reset();
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">
          Subir documento (PDF, JPG o PNG; máximo {formatFileSize(DOCUMENT_MAX_BYTES)})
        </span>
        <input
          name="file"
          type="file"
          accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
          required
          className="text-sm"
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? "Subiendo…" : "Subir"}
      </button>
    </form>
  );
}
