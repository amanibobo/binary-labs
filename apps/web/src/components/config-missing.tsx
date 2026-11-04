export function ConfigMissing({ missing }: { missing: readonly string[] }) {
  return (
    <main className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <h1 className="text-xl font-semibold text-ink">Binary Labs isn&apos;t configured yet</h1>
      <p className="mt-3 text-[15px] text-muted">
        Add these to <span className="font-mono text-[13px] text-ink">apps/web/.env.local</span> and restart the server.
      </p>
      <ul className="mt-4 grid gap-1">
        {missing.map((name) => (
          <li key={name} className="font-mono text-[13px] text-ink">
            {name}
          </li>
        ))}
      </ul>
    </main>
  );
}
