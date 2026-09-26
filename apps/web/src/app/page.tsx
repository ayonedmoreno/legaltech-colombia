import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-semibold">Plataforma LegalTech de Tránsito y Transporte</h1>
      <p className="text-slate-600">Estamos construyendo esta plataforma. Próximamente.</p>
      <nav className="flex gap-4">
        <Link href="/login" className="underline">
          Iniciar sesión
        </Link>
        <Link href="/register" className="underline">
          Crear cuenta
        </Link>
      </nav>
    </main>
  );
}
