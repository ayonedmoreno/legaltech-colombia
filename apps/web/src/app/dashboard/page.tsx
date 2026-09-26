import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { resolveApiInternalUrl } from "../../config/api-proxy";
import { SESSION_COOKIE, getCurrentUser } from "../../lib/session";
import { LogoutButton } from "./logout-button";

export const metadata: Metadata = { title: "Panel" };

/**
 * Empty, protected dashboard (Phase 1 exit criterion, ARCHITECTURE_REPORT.md). The session is
 * checked on the server against the API on every request; without a valid one the user is
 * sent to /login. Case data arrives with Phase 2.
 */
export default async function DashboardPage() {
  const sessionToken = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = await getCurrentUser(sessionToken, resolveApiInternalUrl(process.env));
  if (!user) redirect("/login");

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Panel</h1>
          <p className="text-sm text-slate-600">{user.fullName}</p>
        </div>
        <LogoutButton />
      </header>
      <section className="rounded border border-dashed border-slate-300 p-8 text-center text-slate-600">
        Todavía no hay nada que mostrar aquí.
      </section>
    </main>
  );
}
