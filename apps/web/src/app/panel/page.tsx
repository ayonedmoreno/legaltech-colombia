import type { Case } from "@legaltech/contracts";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveApiInternalUrl } from "../../config/api-proxy";
import {
  CASE_STATUS_LABELS,
  CASE_TYPE_LABELS,
  formatDate,
  splitByActivity,
} from "../../lib/case-labels";
import { getOwnCases } from "../../lib/cases";
import { SESSION_COOKIE, getCurrentUser } from "../../lib/session";
import { LogoutButton } from "./logout-button";
import { SessionKeeper } from "./session-keeper";

export const metadata: Metadata = { title: "Panel" };

function CaseList({ title, cases, empty }: { title: string; cases: Case[]; empty: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">
        {title} ({cases.length})
      </h2>
      {cases.length === 0 ? (
        <p className="text-sm text-slate-600">{empty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-slate-200 rounded border border-slate-200">
          {cases.map((item) => (
            <li key={item.id}>
              <Link
                href={`/casos/${item.id}`}
                className="flex items-center justify-between gap-4 px-4 py-2 hover:bg-slate-50"
              >
                <span>{CASE_TYPE_LABELS[item.type]}</span>
                <span className="text-sm text-slate-600">
                  {CASE_STATUS_LABELS[item.status]} · {formatDate(item.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Protected dashboard (PROJECT_SPEC.md s.11): the user's active and closed cases (Phase 2
 * decision D: closed = RESOLVED, CLOSED, CANCELLED). The session is checked on the server
 * against the API on every request; without a valid one the user is sent to /iniciar-sesion.
 * The rest of s.11 (payments, pending documents, alerts) arrives with its phases.
 */
export default async function DashboardPage() {
  const sessionToken = (await cookies()).get(SESSION_COOKIE)?.value;
  const apiInternalUrl = resolveApiInternalUrl(process.env);
  const user = await getCurrentUser(sessionToken, apiInternalUrl);
  if (!user) redirect("/iniciar-sesion");
  const cases = await getOwnCases(sessionToken, apiInternalUrl);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-10">
      <SessionKeeper />
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Panel</h1>
          <p className="text-sm text-slate-600">{user.fullName}</p>
        </div>
        <LogoutButton />
      </header>
      {cases.kind === "ok" ? (
        <>
          <nav className="flex gap-4 text-sm">
            <Link href="/casos/nuevo" className="rounded bg-slate-900 px-3 py-1.5 text-white">
              Nuevo caso
            </Link>
            <Link href="/casos" className="self-center underline">
              Ver todos mis casos
            </Link>
          </nav>
          <CaseList
            title="Casos activos"
            cases={splitByActivity(cases.data).active}
            empty="No tienes casos activos."
          />
          <CaseList
            title="Casos cerrados"
            cases={splitByActivity(cases.data).closed}
            empty="No tienes casos cerrados."
          />
        </>
      ) : (
        <section className="rounded border border-dashed border-slate-300 p-8 text-center text-slate-600">
          {cases.kind === "not_found"
            ? "Todavía no hay nada que mostrar aquí."
            : "No se pudieron cargar tus casos. Inténtalo de nuevo."}
        </section>
      )}
    </main>
  );
}
