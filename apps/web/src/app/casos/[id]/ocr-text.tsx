import type { DocumentOcrPage } from "@legaltech/contracts";
import { OCR_UNVERIFIED_WARNING } from "../../../lib/case-labels";

/**
 * The OCR text of a document, per page (decisions OCR-A3 and OCR-A13). Untrusted text: React
 * renders it as text nodes, so any markup in it is shown, never interpreted. It is always shown
 * with the warning that it is unverified, and it cannot be edited.
 */
export function OcrText({ pages }: { pages: readonly DocumentOcrPage[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p role="note" className="text-xs text-amber-800">
        {OCR_UNVERIFIED_WARNING}
      </p>
      {pages.length === 0 ? (
        <p className="text-xs text-slate-600">No hay texto disponible.</p>
      ) : (
        pages.map((page) => (
          <section key={page.number} className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-slate-600">Página {page.number}</h3>
            <pre className="max-h-64 overflow-auto rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap">
              {page.text}
            </pre>
          </section>
        ))
      )}
    </div>
  );
}
