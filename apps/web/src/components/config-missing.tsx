export function ConfigMissing({ missing }: { missing: readonly string[] }) {
  return (
    <main className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <h1 className="text-heading-medium">Binary isn&apos;t configured yet</h1>
      <p className="mt-3 text-paragraph-medium text-content-tertiary">
        Add these to <span className="font-mono text-paragraph-small text-content-primary">apps/web/.env.local</span> and restart the server.
      </p>
      <ul className="mt-4 grid gap-1">
        {missing.map((name) => (
          <li key={name} className="font-mono text-paragraph-small text-content-primary">
            {name}
          </li>
        ))}
      </ul>
    </main>
  );
}
