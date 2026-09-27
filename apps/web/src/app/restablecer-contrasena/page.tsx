import type { Metadata } from "next";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Restablecer contraseña" };

/**
 * Target of the password reset email's link (Sprint 1B; visible route in Spanish, PROJECT_SPEC
 * s.39). The token is read in the browser from the URL fragment and posted to the API.
 */
export default function ResetPasswordPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <h1 className="text-2xl font-semibold">Restablecer contraseña</h1>
      <ResetPasswordForm />
    </main>
  );
}
