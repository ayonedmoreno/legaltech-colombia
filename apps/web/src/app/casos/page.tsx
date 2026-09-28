import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveApiInternalUrl } from "../../config/api-proxy";
import { CASE_STATUS_LABELS, CASE_TYPE_LABELS, formatDate } from "../../lib/case-labels";
import { getOwnCases } from "../../lib/cases";
import { SESSION_COOKIE } from "../../lib/session";
import { SessionKeeper } from "../panel/session-keeper";

export const metadata: Metadata = { title: "Mis casos" };

/**
 * The user's own cases (API_SPEC.md, GET /api/cases), most recent first. The API is the only
 * authority on what the user may see; without a valid session the user goes to the login page.
 */
export default async function CasesPage() {
  const sessionToken = (await cookies()).get(SESSION_COOKIE)?.value;
  const result = await getOwnCases(sessionToken, resolveApiInternalUrl(process.env));
  if (result.kind === "unauthenticated") redirect("/iniciar-sesion");

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-10">
      <SessionKeeper />
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Mis casos</h1>
        <nav className="flex gap-4 text-sm">
          <Link href="/panel" className="underline">
            Panel
          </Link>
          {result.kind === "ok" ? (
            <Link href="/casos/nuevo" className="rounded bg-slate-900 px-3 py-1.5 text-white">
              Nuevo caso
            </Link>
          ) : null}
        </nav>
      </header>
      {result.kind === "ok" ? (
        result.data.length === 0 ? (
          <p className="rounded border border-dashed border-slate-300 p-8 text-center text-slate-600">
            Todavía no has creado ningún caso.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-200 rounded border border-slate-200">
            {result.data.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/casos/${item.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-slate-50"
                >
                  <span className="font-medium">{CASE_TYPE_LABELS[item.type]}</span>
                  <span className="text-sm text-slate-600">
                    {CASE_STATUS_LABELS[item.status]} · {formatDate(item.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p role="alert" className="text-slate-600">
          {result.kind === "not_found"
            ? "Los casos no están disponibles para tu cuenta."
            : "No se pudieron cargar tus casos. Inténtalo de nuevo."}
        </p>
      )}
    </main>
  );
}
