// Runs once as each server instance starts. In a production deploy a missing or malformed
// variable stops it here with one list, before any request reaches a route.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertProductionEnv } = await import("./env");
  assertProductionEnv();
}
