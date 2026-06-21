/** Load .env then .env.local into process.env for standalone scripts (Next.js
 * loads these itself; scripts run under tsx/node do not). Existing env wins. */
export function loadEnv(): void {
  for (const file of [".env", ".env.local"]) {
    try {
      // Node 20.12+/22: parses KEY=VALUE without clobbering already-set vars.
      process.loadEnvFile(file);
    } catch {
      // file absent — fine.
    }
  }
}
