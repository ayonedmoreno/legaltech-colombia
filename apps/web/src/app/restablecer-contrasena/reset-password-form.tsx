"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { resetPassword } from "../../lib/api-client";
import { readTokenFromFragment } from "../../lib/verification-link";

const INVALID_LINK = "El enlace no es válido o ha caducado.";

export function ResetPasswordForm() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setToken(readTokenFromFragment(window.location.hash));
    // Drop the token from the address bar and history as soon as it has been read.
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await resetPassword(token, String(form.get("newPassword") ?? ""));
    setPending(false);
    if (result.ok) {
      setDone(true);
      return;
    }
    setError(result.message);
  }

  if (token === undefined) return null;
  if (token === null) {
    return (
      <div role="alert" className="flex flex-col gap-3">
        <p>{INVALID_LINK}</p>
        <Link href="/recuperar-contrasena" className="underline">
          Solicitar un enlace nuevo
        </Link>
      </div>
    );
  }
  if (done) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <p>Tu contraseña se ha cambiado y todas tus sesiones se han cerrado.</p>
        <Link href="/iniciar-sesion" className="underline">
          Iniciar sesión
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Nueva contraseña (12 a 128 caracteres)</span>
        <input
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
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
        {pending ? "Guardando…" : "Cambiar contraseña"}
      </button>
    </form>
  );
}
