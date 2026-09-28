import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveApiInternalUrl } from "../../../config/api-proxy";
import { SESSION_COOKIE, getCurrentUser } from "../../../lib/session";
import { SessionKeeper } from "../../panel/session-keeper";
import { NewCaseForm } from "./new-case-form";

export const metadata: Metadata = { title: "Nuevo caso" };

/**
 * Creation of a case (PROJECT_SPEC.md s.9 step 2): the user only chooses the type of situation.
 * The dynamic questionnaire (step 3) is not part of this slice.
 */
export default async function NewCasePage() {
  const sessionToken = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = await getCurrentUser(sessionToken, resolveApiInternalUrl(process.env));
  if (!user) redirect("/iniciar-sesion");

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-6 py-10">
      <SessionKeeper />
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Nuevo caso</h1>
        <Link href="/casos" className="text-sm underline">
          Mis casos
        </Link>
      </header>
      <NewCaseForm />
    </main>
  );
}
