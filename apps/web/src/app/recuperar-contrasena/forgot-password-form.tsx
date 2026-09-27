"use client";

import { useState, type FormEvent } from "react";
import { forgotPassword } from "../../lib/api-client";

export function ForgotPasswordForm() {
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await forgotPassword(String(form.get("email") ?? ""));
    setPending(false);
    if (result.ok) {
      setAccepted(true);
      return;
    }
    setError(result.message);
  }

  if (accepted) {
    // The same message whether or not the address is registered (API_SPEC.md: no enumeration).
    return (
      <p role="status">
        Si el correo está registrado, te enviaremos un enlace para restablecer tu contraseña.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Correo electrónico</span>
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          className="rounded border border-slate-300 px-3 py-2"
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
        className="rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-60"
      >
        {pending ? "Enviando…" : "Enviar enlace"}
      </button>
    </form>
  );
}
