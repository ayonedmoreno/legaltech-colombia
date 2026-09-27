import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Recuperar contraseña" };

export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <h1 className="text-2xl font-semibold">Recuperar contraseña</h1>
      <ForgotPasswordForm />
      <p className="text-sm text-slate-600">
        <Link href="/iniciar-sesion" className="underline">
          Volver a iniciar sesión
        </Link>
      </p>
    </main>
  );
}
