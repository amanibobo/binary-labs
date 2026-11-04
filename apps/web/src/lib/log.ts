// One JSON line per event so the host's log search can filter on fields.
export function logError(event: string, fields: Record<string, unknown> = {}): void {
  const error = fields.error instanceof Error ? { message: fields.error.message, name: fields.error.name } : fields.error;
  console.error(JSON.stringify({ level: "error", event, ...fields, error, at: new Date().toISOString() }));
}
