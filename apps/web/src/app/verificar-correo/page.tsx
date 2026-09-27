import type { Metadata } from "next";
import { VerifyEmail } from "./verify-email";

export const metadata: Metadata = { title: "Verificar correo" };

/**
 * Target of the verification email's link (Sprint 1B; visible route in Spanish, PROJECT_SPEC
 * s.39). The token is read in the browser from the URL fragment and posted to the API.
 */
export default function VerifyEmailPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <h1 className="text-2xl font-semibold">Verificar correo</h1>
      <VerifyEmail />
    </main>
  );
}
