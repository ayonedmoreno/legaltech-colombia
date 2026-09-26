"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { logout } from "../../lib/api-client";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setError(null);
    const result = await logout();
    if (!result.ok) {
      // The session may still be valid: never pretend the user is logged out.
      setError(result.message);
      setPending(false);
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-60"
      >
        {pending ? "Cerrando sesión…" : "Cerrar sesión"}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
