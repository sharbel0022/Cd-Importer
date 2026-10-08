/** Browsers record in a real container; FFmpeg creates the MP3 afterwards. */
export const RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm", "audio/ogg",
] as const;

export function selectRecordingMime(supports: (mime: string) => boolean): string | undefined {
  return RECORDING_MIME_TYPES.find((mime) => supports(mime));
}

export function recordingExtension(mime: string): "webm" | "m4a" | "ogg" {
  const container = mime.split(";", 1)[0].trim().toLowerCase();
  if (container === "audio/webm") return "webm";
  if (container === "audio/mp4" || container === "audio/x-m4a" || container === "audio/m4a") return "m4a";
  if (container === "audio/ogg" || container === "application/ogg") return "ogg";
  throw new Error("Webbläsarens inspelningsformat stöds inte. Försök med en annan webbläsare.");
}

export function microphoneError(error: unknown): string {
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "Mikrofonåtkomst nekades. Tillåt mikrofonen i webbläsarens inställningar och försök igen.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "Ingen mikrofon hittades. Anslut en mikrofon och försök igen.";
  if (name === "NotReadableError" || name === "TrackStartError") return "Mikrofonen kunde inte öppnas. Stäng andra appar som använder den och försök igen.";
  if (name === "SecurityError") return "Webbläsaren blockerar mikrofonen. Öppna appen via localhost eller HTTPS.";
  return "Inspelningen kunde inte startas. Kontrollera mikrofonen och försök igen.";
}
