export async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(data.error || "Förfrågan misslyckades.");
  return data as T;
}
export function wavBlob(pcm: Int16Array): Blob {
  const buffer = new ArrayBuffer(44 + pcm.byteLength); const view = new DataView(buffer);
  function text(offset: number, value: string) { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); }
  text(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, pcm.byteLength, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return new Blob([buffer], { type: "audio/wav" });
}
export function fileUrl(id: string, target: string, format: string, original = false, download = false) {
  return `/api/translation/jobs/${id}/file?${new URLSearchParams({ target, format, original: String(original), download: String(download) })}`;
}
