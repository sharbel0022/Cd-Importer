/** The filesystem queue is single-user. Hosted mode must fail closed until an
 * authenticated owner/data layer replaces it; opaque job IDs are not access control. */
export function translationDeploymentBlock(url: string, host?: string | null): string | undefined {
  const mode = process.env.STUDIO_DEPLOYMENT_MODE || "local";
  if (mode !== "local") return "Publik AI-backend är inte aktiverad. Autentisering, privata projekt och beständig lagring måste konfigureras före hosted drift.";
  // Next can reconstruct request.url from its loopback bind address. Inspect
  // the received Host as well so a public tunnel hostname is not mistaken for local.
  const allowed = new Set(["localhost", "127.0.0.1", "[::1]"]);
  try {
    const requested = host ? new URL(`http://${host}`) : new URL(url);
    if (!allowed.has(new URL(url).hostname) || !allowed.has(requested.hostname) || requested.username || requested.password || requested.pathname !== "/" && !!host || requested.search || requested.hash) throw new Error("not local");
  } catch { return "Den här AI-studion körs i lokalt enanvändarläge. Öppna den på datorns loopback-adress."; }
}
