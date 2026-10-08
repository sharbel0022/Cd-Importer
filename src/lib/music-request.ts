/** The local Next.js app uses its Node server; Sites replaces this module at build time. */
export function musicRequest(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}
