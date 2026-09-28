"use client";

import type { CaseType } from "@legaltech/contracts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createCase } from "../../../lib/api-client";
import { CASE_TYPES, CASE_TYPE_LABELS } from "../../../lib/case-labels";

export function NewCaseForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const type = new FormData(event.currentTarget).get("type");
    if (typeof type !== "string" || !CASE_TYPES.includes(type as CaseType)) {
      setError("Elige el tipo de situación.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await createCase(type as CaseType);
    if (result.ok) {
      router.replace(`/casos/${result.data.id}`);
      router.refresh();
      return;
    }
    setError(result.message);
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">
          ¿Qué tipo de situación quieres registrar?
        </legend>
        {CASE_TYPES.map((type) => (
          <label key={type} className="flex items-center gap-2">
            <input type="radio" name="type" value={type} required />
            <span>{CASE_TYPE_LABELS[type]}</span>
          </label>
        ))}
      </fieldset>
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
        {pending ? "Creando…" : "Crear caso"}
      </button>
    </form>
  );
}
