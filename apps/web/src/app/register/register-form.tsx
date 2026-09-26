"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { register } from "../../lib/api-client";

export function RegisterForm() {
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await register({
      fullName: String(form.get("fullName") ?? ""),
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    setPending(false);
    if (result.ok) {
      setAccepted(true);
      return;
    }
    setError(result.message);
  }

  if (accepted) {
    // Same message whether or not the email already existed (API_SPEC.md: no enumeration).
    return (
      <div role="status" className="flex flex-col gap-3">
        <p>Solicitud recibida. Si el correo no estaba registrado, tu cuenta ya está creada.</p>
        <Link href="/login" className="underline">
          Ir a iniciar sesión
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Nombre completo</span>
        <input
          name="fullName"
          autoComplete="name"
          required
          maxLength={200}
          className="rounded border border-slate-300 px-3 py-2"
        />
      </label>
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
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Contraseña</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
          aria-describedby="password-help"
          className="rounded border border-slate-300 px-3 py-2"
        />
        <span id="password-help" className="text-xs text-slate-600">
          Entre 12 y 128 caracteres.
        </span>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-60"
      >
        {pending ? "Enviando…" : "Crear cuenta"}
      </button>
    </form>
  );
}
