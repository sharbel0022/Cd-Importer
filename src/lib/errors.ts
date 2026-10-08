export class AppError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "AppError";
  }
}

export function errorResponse(error: unknown): Response {
  const known = error instanceof AppError;
  if (!known) console.error("Music Downloader:", error instanceof Error ? error.message : "Oväntat fel");
  const status = known ? error.status : 500;
  return Response.json(
    { error: known ? error.message : "Ett oväntat serverfel uppstod. Försök igen om en stund." },
    { status, headers: { "Cache-Control": "no-store", ...(status === 429 ? { "Retry-After": "60" } : {}) } },
  );
}
