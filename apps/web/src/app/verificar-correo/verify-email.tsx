"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { verifyEmail } from "../../lib/api-client";
import { readTokenFromFragment } from "../../lib/verification-link";

type State = { kind: "verifying" } | { kind: "verified" } | { kind: "failed"; message: string };

const MISSING_TOKEN = "El enlace no es válido o ha caducado.";

export function VerifyEmail() {
  const [state, setState] = useState<State>({ kind: "verifying" });

  useEffect(() => {
    const token = readTokenFromFragment(window.location.hash);
    // Drop the token from the address bar and history as soon as it has been read.
    window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      setState({ kind: "failed", message: MISSING_TOKEN });
      return;
    }
    void verifyEmail(token).then((result) =>
      setState(result.ok ? { kind: "verified" } : { kind: "failed", message: result.message }),
    );
  }, []);

  if (state.kind === "verifying") {
    return <p role="status">Verificando tu correo…</p>;
  }
  if (state.kind === "verified") {
    return (
      <div role="status" className="flex flex-col gap-3">
        <p>Tu correo está verificado.</p>
        <Link href="/panel" className="underline">
          Ir al panel
        </Link>
      </div>
    );
  }
  return (
    <div role="alert" className="flex flex-col gap-3">
      <p>{state.message}</p>
      <Link href="/iniciar-sesion" className="underline">
        Ir a iniciar sesión
      </Link>
    </div>
  );
}
