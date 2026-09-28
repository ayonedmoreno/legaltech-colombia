import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { resolveApiInternalUrl } from "../../../config/api-proxy";
import {
  CASE_STATUS_LABELS,
  CASE_TYPE_LABELS,
  DOCUMENT_FILE_TYPE_LABELS,
  DOCUMENT_STATUS_LABELS,
  isDownloadable,
  formatDate,
  formatFileSize,
} from "../../../lib/case-labels";
import { getCaseDocuments, getOwnCase } from "../../../lib/cases";
import { SESSION_COOKIE } from "../../../lib/session";
import { SessionKeeper } from "../../panel/session-keeper";
import { DocumentDownload } from "./document-download";
import { DocumentUpload } from "./document-upload";

export const metadata: Metadata = { title: "Caso" };

/**
 * One of the user's own cases with its status history (API_SPEC.md, GET /api/cases/:caseId)
 * and its documents (GET /api/cases/:caseId/documents); uploads only while the case is a DRAFT.
 * Another user's case, an unknown one and a malformed id all show the same "not found" page.
 */
export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionToken = (await cookies()).get(SESSION_COOKIE)?.value;
  const apiInternalUrl = resolveApiInternalUrl(process.env);
  const result = await getOwnCase(id, sessionToken, apiInternalUrl);
  if (result.kind === "unauthenticated") redirect("/iniciar-sesion");
  if (result.kind === "not_found") notFound();
  const documents =
    result.kind === "ok" ? await getCaseDocuments(id, sessionToken, apiInternalUrl) : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-10">
      <SessionKeeper />
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">
          {result.kind === "ok" ? CASE_TYPE_LABELS[result.data.case.type] : "Caso"}
        </h1>
        <Link href="/casos" className="text-sm underline">
          Mis casos
        </Link>
      </header>
      {result.kind === "ok" ? (
        <>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
            <dt className="text-slate-600">Estado</dt>
            <dd className="font-medium">{CASE_STATUS_LABELS[result.data.case.status]}</dd>
            <dt className="text-slate-600">Creado</dt>
            <dd>{formatDate(result.data.case.createdAt)}</dd>
          </dl>
          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Historial de estados</h2>
            <ol className="flex flex-col gap-1 text-sm">
              {result.data.statusHistory.map((change) => (
                <li key={`${change.changedAt}-${change.toStatus}`}>
                  {formatDate(change.changedAt)} —{" "}
                  {change.fromStatus
                    ? `${CASE_STATUS_LABELS[change.fromStatus]} → ${CASE_STATUS_LABELS[change.toStatus]}`
                    : `Creado en ${CASE_STATUS_LABELS[change.toStatus]}`}
                </li>
              ))}
            </ol>
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Documentos</h2>
            {documents?.kind === "ok" ? (
              documents.data.length === 0 ? (
                <p className="text-sm text-slate-600">Todavía no has subido documentos.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-slate-200 rounded border border-slate-200">
                  {documents.data.map((document) => (
                    <li
                      key={document.id}
                      className="flex items-center justify-between gap-4 px-4 py-2 text-sm"
                    >
                      <span className="flex flex-col">
                        <span className="font-medium break-all">{document.fileName}</span>
                        <span className="text-slate-600">
                          {DOCUMENT_FILE_TYPE_LABELS[document.fileType]} ·{" "}
                          {formatFileSize(document.fileSize)} · {formatDate(document.createdAt)} ·{" "}
                          {DOCUMENT_STATUS_LABELS[document.status]}
                        </span>
                      </span>
                      {isDownloadable(document.status) ? (
                        <DocumentDownload caseId={id} documentId={document.id} />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <p role="alert" className="text-sm text-slate-600">
                No se pudieron cargar los documentos. Inténtalo de nuevo.
              </p>
            )}
            {result.data.case.status === "DRAFT" ? <DocumentUpload caseId={id} /> : null}
          </section>
        </>
      ) : (
        <p role="alert" className="text-slate-600">
          No se pudo cargar el caso. Inténtalo de nuevo.
        </p>
      )}
    </main>
  );
}
